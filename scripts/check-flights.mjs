import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

// ============================================================
// CONFIGURACIÓN
// ============================================================

const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;
const WEBSITE_MAX_PRICE = 1000;

// ============================================================
// AEROPUERTOS DE SALIDA
// ============================================================

const origins = [
  {
    airport: "EZE",
    city: "Buenos Aires",
    country: "Argentina",
    flag: "🇦🇷",
    gl: "ar"
  },
  {
    airport: "SCL",
    city: "Santiago",
    country: "Chile",
    flag: "🇨🇱",
    gl: "cl"
  },
  {
    airport: "GRU",
    city: "São Paulo",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  },
  {
    airport: "GIG",
    city: "Río de Janeiro",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
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

async function searchEurope(origin, duration) {
  const query = new URLSearchParams({
    engine: "google_travel_explore",

    departure_id: origin.airport,

    // Europa
    arrival_area_id: "/m/02j9z",

    // Ida y vuelta
    type: "1",

    // Fechas flexibles
    month: "0",

    travel_duration: duration.value,

    travel_class: "1",

    adults: "1",

    currency: "USD",

    max_price: String(WEBSITE_MAX_PRICE),

    travel_mode: "1",

    hl: "en",

    gl: origin.gl,

    api_key: required("SERPAPI_KEY")
  });

  const response = await fetch(
    `https://serpapi.com/search.json?${query}`
  );

  if (!response.ok) {
    throw new Error(
      `SerpApi ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data.destinations || [];
}

// ============================================================
// ESCALAS
// ============================================================

function getStops(item) {
  const raw = item.number_of_stops;

  // MUY IMPORTANTE:
  // null/undefined NO significa directo.
  if (
    raw === null ||
    raw === undefined ||
    raw === ""
  ) {
    return null;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

// ============================================================
// NORMALIZAR RESULTADOS
// ============================================================

function summarize(item, duration, origin) {
  const destinationAirport =
    item.destination_airport || {};

  const destination =
    destinationAirport.code ||
    item.destination_airport_code ||
    item.name;

  const stops = getStops(item);

  return {
    key:
      `${origin.airport}-${destination}-${item.start_date}-${item.end_date}-${duration.value}`,

    origin: origin.airport,

    originCity: origin.city,

    originCountry: origin.country,

    originFlag: origin.flag,

    destination,

    destinationName:
      item.name || destination,

    country:
      item.country || "Europa",

    route:
      `${origin.airport} → ${destination}`,

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

    duration:
      duration.label,

    season:
      `Fechas flexibles · ${duration.label}`,

    source:
      "Google Travel / SerpApi",

    foundAt:
      new Date().toISOString(),

    foundToday: true,

    previousPrice: null,

    priceDrop: 0,

    url:
      item.link ||
      "https://www.google.com/travel/explore?hl=es&curr=USD"
  };
}

// ============================================================
// EMAIL
// ============================================================

async function sendEmail(result) {
  const user = required("EMAIL_USER");

  const transporter =
    nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,

      auth: {
        user,
        pass: required("EMAIL_APP_PASSWORD")
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
      ? "Consultar"
      : result.stops === 0
        ? "Directo"
        : `${result.stops} escala${result.stops > 1 ? "s" : ""}`;

  await transporter.sendMail({
    from:
      `Eurotrip <${user}>`,

    to:
      required("EMAIL_TO"),

    subject:
      direct
        ? `✈️ DIRECTO ${result.origin} → ${result.destinationName} · USD ${result.price.toFixed(0)}`
        : `🔥 ${result.origin} → ${result.destinationName} · USD ${result.price.toFixed(0)}`,

    text: [
      reason,
      "",
      `${result.originFlag} Salida desde ${result.originCity}, ${result.originCountry}`,
      "",
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

state.alerted ||= {};

// ============================================================
// EJECUTAR
// ============================================================

try {

  // ==========================================================
  // CREAR LAS 8 BÚSQUEDAS
  //
  // EZE x 2
  // SCL x 2
  // GRU x 2
  // GIG x 2
  // ==========================================================

  const jobs = [];

  for (const origin of origins) {
    for (const duration of durations) {
      jobs.push({
        origin,
        duration
      });
    }
  }

  // ==========================================================
  // EJECUTAR SIN QUE UNA FALLA ROMPA TODO
  // ==========================================================

  const results =
    await Promise.allSettled(
      jobs.map(
        async ({ origin, duration }) => {

          const destinations =
            await searchEurope(
              origin,
              duration
            );

          return {
            origin,
            duration,
            destinations
          };
        }
      )
    );

  // ==========================================================
  // PROCESAR RESULTADOS
  // ==========================================================

  const found = [];
  const searchErrors = [];

  results.forEach(
    (result, index) => {

      const job =
        jobs[index];

      if (
        result.status === "rejected"
      ) {

        const message =
          `${job.origin.airport} · ${job.duration.label}: ${result.reason?.message || "Error desconocido"}`;

        searchErrors.push(message);

        console.warn(
          `⚠️ ${message}`
        );

        return;
      }

      const {
        origin,
        duration,
        destinations
      } = result.value;

      console.log(
        `✓ ${origin.airport} · ${duration.label}: ${destinations.length} destinos`
      );

      for (
        const item of destinations
      ) {

        if (
          !Number.isFinite(
            Number(item.flight_price)
          )
        ) {
          continue;
        }

        if (
          !item.start_date ||
          !item.end_date
        ) {
          continue;
        }

        found.push(
          summarize(
            item,
            duration,
            origin
          )
        );
      }
    }
  );

  // ==========================================================
  // SI FALLAN TODAS LAS BÚSQUEDAS
  // ==========================================================

  if (
    found.length === 0 &&
    searchErrors.length === jobs.length
  ) {
    throw new Error(
      "Fallaron todas las búsquedas de vuelos."
    );
  }

  // ==========================================================
  // SOLO VUELOS FUTUROS + <= USD 1000
  // ==========================================================

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const validOffers =
    found.filter(
      offer =>
        offer.returnDate >= today &&
        Number.isFinite(
          Number(offer.price)
        ) &&
        offer.price <= WEBSITE_MAX_PRICE
    );

  // ==========================================================
  // ELIMINAR DUPLICADOS
  // ==========================================================

  const uniqueMap =
    new Map();

  for (const offer of validOffers) {

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

    if (
      !existing ||
      offer.price < existing.price
    ) {
      uniqueMap.set(
        duplicateKey,
        offer
      );
    }
  }

  // ==========================================================
  // ORDENAR
  // ==========================================================

  const currentOffers =
    [...uniqueMap.values()]
      .sort(
        (a, b) =>
          a.price - b.price
      )
      .slice(0, 200);

  // La web muestra SOLAMENTE esta búsqueda.
  state.offers =
    currentOffers;

  state.lastRun =
    new Date()
      .toISOString();

  // Guardamos errores parciales si los hubo.
  state.lastErrors =
    searchErrors;

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

          const previous =
            state.alerted[
              offer.key
            ];

          return (
            !previous ||
            offer.price <
              previous.price
          );
        }
      )

      .sort(
        (a, b) =>
          a.price - b.price
      );

  // Mandar solamente la mejor alerta
  const newest =
    alertCandidates[0];

 let emailSent = false;
let emailError = null;

if (newest) {
  try {

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

    emailSent = true;

  } catch (error) {

    emailError =
      error.message;

    console.warn(
      `⚠️ No se pudo enviar el correo: ${error.message}`
    );

    /*
     * IMPORTANTE:
     * El error de Gmail NO detiene
     * la búsqueda ni la publicación.
     */
  }
}
  // ==========================================================
  // CONTADORES
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
  // RESUMEN
  // ==========================================================

  console.log("");
  console.log("==========================================");
  console.log("🌍 EUROTRIP — RESULTADO");
  console.log("==========================================");

  console.log(
    `Ofertas actuales: ${currentOffers.length}`
  );

  console.log(
    `🇦🇷 Argentina: ${argentina}`
  );

  console.log(
    `🇨🇱 Chile: ${chile}`
  );

  console.log(
    `🇧🇷 Brasil: ${brasil}`
  );

  console.log(
    `✈️ Directas confirmadas: ${directCount}`
  );

console.log(
  `📧 Correo enviado: ${emailSent ? "sí" : "no"}`
);

if (emailError) {
  console.log(
    `⚠️ Error de correo: ${emailError}`
  );
}

  console.log(
    `⚠️ Búsquedas con error: ${searchErrors.length}`
  );

  if (currentOffers.length > 0) {

    const cheapest =
      currentOffers[0];

    console.log(
      `💰 Más barata: ${cheapest.route} · USD ${cheapest.price}`
    );
  }

  console.log("==========================================");

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
