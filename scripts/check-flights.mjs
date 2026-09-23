import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

// ============================================================
// CONFIGURACIÓN
// ============================================================

// Cualquier vuelo <= USD 800 genera alerta
const EMAIL_MAX_PRICE = 800;

// Vuelo DIRECTO <= USD 900 también genera alerta
const DIRECT_EMAIL_MAX_PRICE = 900;

// La web muestra hasta USD 1000
const WEBSITE_MAX_PRICE = 1000;

// ============================================================
// ORÍGENES
// Argentina + Chile + Brasil
// ============================================================

const originGroups = [
  {
    country: "Argentina",
    flag: "🇦🇷",
    gl: "ar",
    airports: [
      "EZE",
      "AEP",
      "COR",
      "MDZ",
      "ROS",
      "SLA",
      "TUC",
      "NQN",
      "BRC",
      "IGR",
      "USH"
    ]
  },
  {
    country: "Chile",
    flag: "🇨🇱",
    gl: "cl",
    airports: [
      "SCL"
    ]
  },
  {
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br",
    airports: [
      "GRU",
      "GIG",
      "VCP",
      "BSB",
      "CNF",
      "POA",
      "CWB",
      "SSA",
      "REC",
      "FOR"
    ]
  }
];

// ============================================================
// DURACIONES
// ============================================================

const durations = [
  {
    value: "2",
    label: "Una semana"
  },
  {
    value: "3",
    label: "Dos semanas"
  }
];

// ============================================================
// SECRETS
// ============================================================

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

async function searchEurope(originGroup, duration) {
  const query = new URLSearchParams({
    engine: "google_travel_explore",

    // Varios aeropuertos del mismo país
    departure_id: originGroup.airports.join(","),

    // Europa
    arrival_area_id: "/m/02j9z",

    // Ida y vuelta
    type: "1",

    // Fechas flexibles
    month: "0",

    // 1 o 2 semanas
    travel_duration: duration.value,

    // Económica
    travel_class: "1",

    adults: "1",

    currency: "USD",

    max_price: String(WEBSITE_MAX_PRICE),

    travel_mode: "1",

    hl: "en",

    gl: originGroup.gl,

    api_key: required("SERPAPI_KEY")
  });

  const response = await fetch(
    `https://serpapi.com/search.json?${query}`
  );

  if (!response.ok) {
    throw new Error(
      `SerpApi respondió ${response.status} buscando desde ${originGroup.country}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      `${originGroup.country}: ${data.error}`
    );
  }

  return data.destinations || [];
}

// ============================================================
// OBTENER AEROPUERTO DE ORIGEN
// ============================================================

function getOrigin(item, originGroup) {
  const possibleOrigins = [
    item.departure_airport?.code,
    item.origin_airport?.code,
    item.departure_airport_code,
    item.origin_airport_code,
    item.departure_id,
    item.origin
  ];

  const detected = possibleOrigins.find(
    value =>
      typeof value === "string" &&
      value.trim().length >= 3
  );

  if (detected) {
    return detected.trim().toUpperCase();
  }

  /*
   * Si el resultado no especifica qué aeropuerto
   * del grupo produjo el precio, NO inventamos uno.
   */
  if (originGroup.airports.length === 1) {
    return originGroup.airports[0];
  }

  return originGroup.country;
}

// ============================================================
// OBTENER ESCALAS DE FORMA SEGURA
// ============================================================

function getStops(item) {
  const rawStops = item.number_of_stops;

  if (
    rawStops === null ||
    rawStops === undefined ||
    rawStops === ""
  ) {
    return null;
  }

  const parsed = Number(rawStops);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

// ============================================================
// NORMALIZAR RESULTADO
// ============================================================

function summarize(item, duration, originGroup) {
  const destinationAirport =
    item.destination_airport || {};

  const destination =
    destinationAirport.code ||
    item.destination_airport_code ||
    item.name;

  const origin =
    getOrigin(item, originGroup);

  const stops =
    getStops(item);

  return {
    key:
      `${origin}-${destination}-${item.start_date}-${item.end_date}-${duration.value}`,

    origin,

    originCountry:
      originGroup.country,

    originFlag:
      originGroup.flag,

    destination,

    destinationName:
      item.name || destination,

    country:
      item.country || "Europa",

    route:
      `${origin} → ${destination}`,

    departure:
      item.start_date,

    returnDate:
      item.end_date,

    price:
      Number(item.flight_price),

    airlines:
      item.airline || "consultar",

    stops,

    direct:
      stops === 0,

    season:
      `Fechas flexibles · ${duration.label}`,

    duration:
      duration.label,

    foundAt:
      new Date().toISOString(),

    foundToday:
      true,

    previousPrice:
      null,

    priceDrop:
      0,

    source:
      "Google Travel / SerpApi",

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
          required("EMAIL_APP_PASSWORD")
      }
    });

  const direct =
    result.stops === 0;

  const reason =
    direct &&
    result.price > EMAIL_MAX_PRICE
      ? "✈️ VUELO DIRECTO ENCONTRADO"
      : "🔥 OFERTA DENTRO DE TU PRESUPUESTO";

  const stopsText =
    result.stops === null
      ? "consultar"
      : result.stops === 0
        ? "Directo"
        : `${result.stops}`;

  await transporter.sendMail({
    from:
      `Eurotrip <${user}>`,

    to:
      required("EMAIL_TO"),

    subject:
      direct
        ? `✈️ DIRECTO ${result.origin} → ${result.destinationName} por USD ${result.price.toFixed(0)}`
        : `🔥 ${result.origin} → ${result.destinationName} por USD ${result.price.toFixed(0)}`,

    text: [
      reason,

      "",

      `${result.originFlag} Salida desde ${result.originCountry}`,

      result.route,

      "",

      `Destino: ${result.destinationName}, ${result.country}`,

      `Fechas: ${result.departure} al ${result.returnDate}`,

      `Precio ida y vuelta: USD ${result.price.toFixed(2)}`,

      `Aerolínea: ${result.airlines}`,

      `Escalas: ${stopsText}`,

      `Duración: ${result.duration}`,

      `Fuente: ${result.source}`,

      "",

      `Verificar vuelo: ${result.url}`
    ].join("\n")
  });
}

// ============================================================
// LEER ESTADO
// ============================================================

let state;

try {
  state =
    JSON.parse(
      await fs.readFile(
        STATE_FILE,
        "utf8"
      )
    );
} catch {
  state = {
    offers: [],
    alerted: {}
  };
}

// Mantener alertas históricas
state.alerted ||= {};

// ============================================================
// EJECUTAR
// ============================================================

try {

  // ==========================================================
  // 3 PAÍSES × 2 DURACIONES = 6 BÚSQUEDAS
  // ==========================================================

  const jobs = [];

  for (const originGroup of originGroups) {
    for (const duration of durations) {
      jobs.push({
        originGroup,
        duration
      });
    }
  }

  const searches =
    await Promise.all(
      jobs.map(
        async ({
          originGroup,
          duration
        }) => {

          const destinations =
            await searchEurope(
              originGroup,
              duration
            );

          return destinations

            .filter(
              item =>
                Number.isFinite(
                  Number(
                    item.flight_price
                  )
                ) &&
                item.start_date &&
                item.end_date
            )

            .map(
              item =>
                summarize(
                  item,
                  duration,
                  originGroup
                )
            );
        }
      )
    );

  // ==========================================================
  // JUNTAR RESULTADOS
  // ==========================================================

  const found =
    searches.flat();

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  // ==========================================================
  // ELIMINAR DUPLICADOS
  // ==========================================================

  const uniqueMap =
    new Map();

  for (const offer of found) {

    if (
      offer.returnDate < today
    ) {
      continue;
    }

    if (
      !Number.isFinite(
        Number(offer.price)
      )
    ) {
      continue;
    }

    if (
      offer.price >
      WEBSITE_MAX_PRICE
    ) {
      continue;
    }

    const duplicateKey =
      [
        offer.origin,
        offer.destination,
        offer.departure,
        offer.returnDate
      ].join("-");

    const existing =
      uniqueMap.get(
        duplicateKey
      );

    /*
     * Si encontramos la misma ruta/fecha
     * más de una vez, conservar la más barata.
     */
    if (
      !existing ||
      offer.price <
        existing.price
    ) {
      uniqueMap.set(
        duplicateKey,
        offer
      );
    }
  }

  // ==========================================================
  // RESULTADOS ACTUALES
  // ==========================================================

  const currentOffers =
    [...uniqueMap.values()]

      .sort(
        (a, b) =>
          a.price - b.price
      )

      .slice(0, 150);

  /*
   * IMPORTANTE:
   *
   * Seguimos mostrando solamente
   * resultados de ESTA ejecución.
   *
   * No volvemos a acumular ofertas viejas.
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

  const alertCandidates =
    currentOffers

      .filter(
        offer => {

          const normalDeal =
            offer.price <=
            EMAIL_MAX_PRICE;

          const directDeal =
            offer.stops === 0 &&
            offer.price <=
            DIRECT_EMAIL_MAX_PRICE;

          return (
            normalDeal ||
            directDeal
          );
        }
      )

      .filter(
        offer => {

          const previousAlert =
            state.alerted[
              offer.key
            ];

          return (
            !previousAlert ||
            offer.price <
              previousAlert.price
          );
        }
      )

      .sort(
        (a, b) =>
          a.price - b.price
      );

  // ==========================================================
  // ENVIAR SOLO LA MEJOR ALERTA
  // ==========================================================

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
          .toISOString(),

      origin:
        newest.origin,

      destination:
        newest.destination
    };
  }

  // ==========================================================
  // ESTADÍSTICAS
  // ==========================================================

  const argentina =
    currentOffers.filter(
      x =>
        x.originCountry ===
        "Argentina"
    ).length;

  const chile =
    currentOffers.filter(
      x =>
        x.originCountry ===
        "Chile"
    ).length;

  const brasil =
    currentOffers.filter(
      x =>
        x.originCountry ===
        "Brasil"
    ).length;

  const directCount =
    currentOffers.filter(
      x =>
        x.stops === 0
    ).length;

  // ==========================================================
  // LOG
  // ==========================================================

  console.log(
    [
      `Europa: ${currentOffers.length} ofertas actuales.`,
      `🇦🇷 Argentina: ${argentina}.`,
      `🇨🇱 Chile: ${chile}.`,
      `🇧🇷 Brasil: ${brasil}.`,
      `✈️ Directas: ${directCount}.`,
      `📧 Correo: ${newest ? "sí" : "no"}.`
    ].join(" ")
  );

} catch (error) {

  state.lastRun =
    new Date()
      .toISOString();

  state.lastErrors =
    [
      error.message
    ];

  console.error(
    "ERROR:",
    error.message
  );

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
