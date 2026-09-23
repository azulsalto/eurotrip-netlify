import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

// ============================================================
// CONFIGURACIÓN
// ============================================================

// Alerta para cualquier vuelo hasta USD 800
const EMAIL_MAX_PRICE = 800;

// Si el vuelo es directo, alertar también hasta USD 900
const DIRECT_EMAIL_MAX_PRICE = 900;

// La web muestra vuelos de hasta USD 1000
const WEBSITE_MAX_PRICE = 1000;

// Buscar SIEMPRE viajes de 1 y 2 semanas
const durations = [
  { value: "2", label: "Una semana" },
  { value: "3", label: "Dos semanas" }
];

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Falta el secreto ${name}`);
  }

  return value;
}

// ============================================================
// BUSCAR VUELOS
// ============================================================

async function searchEurope(duration) {
  const query = new URLSearchParams({
    engine: "google_travel_explore",

    departure_id: "EZE",
    arrival_area_id: "/m/02j9z",

    type: "1",
    month: "0",

    travel_duration: duration.value,

    travel_class: "1",
    adults: "1",

    currency: "USD",

    max_price: String(WEBSITE_MAX_PRICE),

    stops: "0",
    travel_mode: "1",

    hl: "en",
    gl: "ar",

    api_key: required("SERPAPI_KEY")
  });

  const response = await fetch(
    `https://serpapi.com/search.json?${query}`
  );

  if (!response.ok) {
    throw new Error(
      `SerpApi respondió ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data.destinations || [];
}

// ============================================================
// NORMALIZAR RESULTADOS
// ============================================================

function summarize(item, duration) {
  const airport =
    item.destination_airport || {};

  const destination =
    airport.code || item.name;

  const stopsNumber =
    Number(item.number_of_stops);

  return {
    key:
      `EZE-${destination}-${item.start_date}-${item.end_date}`,

    origin: "EZE",

    destination,

    destinationName:
      item.name || destination,

    country:
      item.country || "Europa",

    route:
      `EZE → ${destination}`,

    departure:
      item.start_date,

    returnDate:
      item.end_date,

    price:
      Number(item.flight_price),

    airlines:
      item.airline || "consultar",

    stops:
      Number.isFinite(stopsNumber)
        ? stopsNumber
        : null,

    season:
      `Fechas flexibles · ${duration.label}`,

    foundAt:
      new Date().toISOString(),

    foundToday:
      true,

    previousPrice:
      null,

    priceDrop:
      0,

    url:
      item.link ||
      "https://www.google.com/travel/explore?hl=es&curr=USD"
  };
}

// ============================================================
// EMAIL
// ============================================================

async function sendEmail(result) {
  const user =
    required("EMAIL_USER");

  const transporter =
    nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,

      auth: {
        user,
        pass:
          required(
            "EMAIL_APP_PASSWORD"
          )
      }
    });

  const direct =
    result.stops === 0;

  const reason =
    direct &&
    result.price > EMAIL_MAX_PRICE
      ? "✈️ VUELO DIRECTO ENCONTRADO"
      : "🔥 OFERTA DENTRO DE TU PRESUPUESTO";

  await transporter.sendMail({
    from:
      `Eurotrip <${user}>`,

    to:
      required("EMAIL_TO"),

    subject:
      direct
        ? `✈️ DIRECTO a ${result.destinationName} por USD ${result.price.toFixed(0)}`
        : `🔥 Oferta a ${result.destinationName} por USD ${result.price.toFixed(0)}`,

    text: [
      reason,

      "",

      result.route,

      "",

      `Destino: ${result.destinationName}, ${result.country}`,

      `Fechas: ${result.departure} al ${result.returnDate}`,

      `Precio ida y vuelta: USD ${result.price.toFixed(2)}`,

      `Aerolínea: ${result.airlines}`,

      `Escalas: ${
        result.stops === null
          ? "consultar"
          : result.stops
      }`,

      `Duración: ${result.season}`,

      "",

      `Verificar vuelo: ${result.url}`
    ].join("\n")
  });
}

// ============================================================
// LEER ESTADO ANTERIOR
// ============================================================

const state =
  JSON.parse(
    await fs.readFile(
      STATE_FILE,
      "utf8"
    )
  );

// Mantener historial de alertas para no mandar el mismo mail
state.alerted ||= {};

try {

  // ==========================================================
  // BUSCAR 1 Y 2 SEMANAS TODOS LOS DÍAS
  // ==========================================================

  const searches =
    await Promise.all(
      durations.map(
        async duration => {

          const destinations =
            await searchEurope(
              duration
            );

          return destinations

            .filter(
              x =>
                Number.isFinite(
                  Number(
                    x.flight_price
                  )
                ) &&
                x.start_date &&
                x.end_date
            )

            .map(
              x =>
                summarize(
                  x,
                  duration
                )
            );
        }
      )
    );

  // Juntar resultados de ambas búsquedas
  const found =
    searches.flat();

  // ==========================================================
  // LIMPIAR Y GUARDAR SOLO LA BÚSQUEDA ACTUAL
  // ==========================================================

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const currentOffers =
    found

      // Solo vuelos futuros
      .filter(
        x =>
          x.returnDate >= today
      )

      // Solo vuelos hasta USD 1000
      .filter(
        x =>
          Number.isFinite(
            Number(x.price)
          ) &&
          Number(x.price) <=
            WEBSITE_MAX_PRICE
      )

      // Ordenar de más barato a más caro
      .sort(
        (a, b) =>
          a.price - b.price
      )

      // Máximo 100 resultados
      .slice(0, 100);

  /*
   * IMPORTANTE:
   *
   * La web ahora muestra SOLO lo encontrado
   * en esta ejecución.
   *
   * Ya no mezcla resultados viejos.
   */

  state.offers =
    currentOffers;

  state.lastRun =
    new Date()
      .toISOString();

  state.lastErrors =
    [];

  // ==========================================================
  // ALERTAS
  // ==========================================================
  //
  // Mandar mail si:
  //
  // 1. cualquier vuelo cuesta <= USD 800
  //
  // O
  //
  // 2. es DIRECTO y cuesta <= USD 900
  //
  // Además:
  //
  // - nunca se avisó esa combinación
  // - o ahora está más barata
  //
  // ==========================================================

  const alertCandidates =
    currentOffers

      .filter(
        x =>
          (
            x.price <=
              EMAIL_MAX_PRICE

            ||

            (
              x.stops === 0 &&
              x.price <=
                DIRECT_EMAIL_MAX_PRICE
            )
          )
      )

      .filter(
        x =>
          !state.alerted?.[x.key]

          ||

          x.price <
            state.alerted[x.key].price
      )

      .sort(
        (a, b) =>
          a.price - b.price
      );

  // Por ahora mandamos solamente
  // la mejor alerta de cada ejecución
  const newest =
    alertCandidates[0];

  if (newest) {

    await sendEmail(
      newest
    );

    state.alerted[
      newest.key
    ] = {
      price:
        newest.price,

      sentAt:
        new Date()
          .toISOString()
    };
  }

  // ==========================================================
  // LOG DE GITHUB ACTIONS
  // ==========================================================

  const directCount =
    currentOffers.filter(
      x =>
        x.stops === 0
    ).length;

  console.log(
    `Europa: ${currentOffers.length} ofertas actuales ` +
    `(1 y 2 semanas); ` +
    `${directCount} directas; ` +
    `correo: ${newest ? "sí" : "no"}.`
  );

} catch (error) {

  state.lastRun =
    new Date()
      .toISOString();

  state.lastErrors =
    [
      error.message
    ];

  throw error;

} finally {

  await fs.writeFile(
    STATE_FILE,

    JSON.stringify(
      state,
      null,
      2
    ) + "\n"
  );
}
