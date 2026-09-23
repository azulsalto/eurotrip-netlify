import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const WEBSITE_MAX_PRICE = 1000;
const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;

/*
 * EUROTRIP GIRLS
 *
 * Objetivo:
 * encontrar oportunidades económicas ida y vuelta a Europa.
 *
 * La duración del viaje NO es un filtro de calidad.
 * Buscamos varias duraciones y después priorizamos PRECIO.
 */

const origins = [
  {
    airport: "EZE",
    city: "Buenos Aires · Ezeiza",
    country: "Argentina",
    flag: "🇦🇷",
    gl: "ar"
  },
  {
    airport: "AEP",
    city: "Buenos Aires · Aeroparque",
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
    city: "São Paulo · Guarulhos",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  },
  {
    airport: "GIG",
    city: "Río de Janeiro · Galeão",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  }
];

/*
 * Google Travel Explore:
 * 1 = fin de semana
 * 2 = una semana
 * 3 = dos semanas
 *
 * No descartamos una oferta por duración.
 * Estas opciones sirven para ampliar el radar.
 */

const durations = [
  {
    value: "1",
    label: "Fin de semana"
  },
  {
    value: "2",
    label: "Una semana"
  },
  {
    value: "3",
    label: "Dos semanas"
  }
];

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Falta el secreto ${name}`);
  }

  return value;
}

async function serpApi(params) {
  params.set("api_key", required("SERPAPI_KEY"));

  const response = await fetch(
    `https://serpapi.com/search.json?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`SerpApi HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}

/*
 * =========================
 * BUSCAR EUROPA
 * =========================
 */

async function exploreEurope(origin, duration) {
  const params = new URLSearchParams({
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

    // Avión
    travel_mode: "1",

    hl: "en",

    gl: origin.gl
  });

  const data = await serpApi(params);

  return Array.isArray(data.destinations)
    ? data.destinations
    : [];
}

/*
 * =========================
 * HELPERS
 * =========================
 */

function getDestinationCode(deal) {
  return (
    deal.destination_airport?.code ||
    deal.destination_airport?.id ||
    deal.destination_airport_code ||
    deal.arrival_airport?.code ||
    deal.arrival_airport?.id ||
    deal.arrival_airport_code ||
    null
  );
}

function getPrice(deal) {
  const price = Number(
    deal.flight_price ??
    deal.price
  );

  return Number.isFinite(price)
    ? price
    : null;
}

function calculateTripDays(departure, returnDate) {
  if (!departure || !returnDate) {
    return null;
  }

  const start = new Date(`${departure}T12:00:00Z`);
  const end = new Date(`${returnDate}T12:00:00Z`);

  const days = Math.round(
    (end - start) /
    (1000 * 60 * 60 * 24)
  );

  return Number.isFinite(days)
    ? days
    : null;
}

function normalizeStops(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const stops = Number(value);

  return Number.isFinite(stops)
    ? stops
    : null;
}

/*
 * =========================
 * CONVERTIR RESULTADO
 * =========================
 *
 * Usamos directamente los datos devueltos
 * por Google Travel Explore.
 *
 * Esto evita hacer una segunda consulta
 * por cada ruta.
 */

function createOffer(origin, duration, deal) {
  const destination = getDestinationCode(deal);
  const price = getPrice(deal);

  if (
    !destination ||
    !deal.start_date ||
    !deal.end_date ||
    price === null ||
    price > WEBSITE_MAX_PRICE ||
    !deal.link
  ) {
    return null;
  }

  const stops = normalizeStops(
    deal.number_of_stops ??
    deal.stops
  );

  const tripDays = calculateTripDays(
    deal.start_date,
    deal.end_date
  );

  return {
    key: [
      origin.airport,
      destination,
      deal.start_date,
      deal.end_date
    ].join("-"),

    origin: origin.airport,

    originCity: origin.city,

    originCountry: origin.country,

    originFlag: origin.flag,

    destination,

    destinationName:
      deal.name ||
      deal.destination_airport?.location ||
      destination,

    country:
      deal.country ||
      "Europa",

    route:
      `${origin.airport} → ${destination}`,

    departure:
      deal.start_date,

    returnDate:
      deal.end_date,

    tripDays,

    roundTrip: true,

    tripType: "round_trip",

    tripTypeLabel: "Ida y vuelta",

    price,

    airlines:
      deal.airline ||
      deal.airlines ||
      "Aerolínea por confirmar",

    airlineCode:
      deal.airline_code ||
      null,

    stops,

    direct:
      stops === 0,

    flightDuration:
      deal.flight_duration ||
      null,

    source:
      "Google Travel Explore / SerpApi",

    url:
      deal.link,

    /*
     * Verificada significa que la oferta
     * viene directamente del resultado
     * actual de Google Travel Explore.
     */
    verified: true,

    roundTripVerified: true,

    durationSearch:
      duration.label,

    foundToday: true,

    foundAt:
      new Date().toISOString()
  };
}

/*
 * =========================
 * EMAIL
 * =========================
 */

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

  const stopsText =
    result.stops === null
      ? "Por confirmar"
      : result.stops === 0
        ? "Directo"
        : `${result.stops} ${
            result.stops === 1
              ? "escala"
              : "escalas"
          }`;

  const durationText =
    result.tripDays !== null
      ? `${result.tripDays} días`
      : "Consultar";

  const lines = [
    "✈️ EUROTRIP GIRLS",
    "",
    `${result.originFlag} ${result.route}`,
    "",
    `${result.destinationName}, ${result.country}`,
    "",
    `Ida: ${result.departure}`,
    `Vuelta: ${result.returnDate}`,
    `Duración del viaje: ${durationText}`,
    "",
    `Precio ida y vuelta: USD ${result.price.toFixed(0)}`,
    `Aerolínea: ${result.airlines}`,
    `Escalas: ${stopsText}`,
    "",
    `Ver oferta: ${result.url}`
  ];

  await transporter.sendMail({
    from: `Eurotrip Girls <${user}>`,

    to: required("EMAIL_TO"),

    subject:
      result.direct
        ? `✈️ DIRECTO ${result.route} · USD ${result.price.toFixed(0)}`
        : `🔥 ${result.route} · USD ${result.price.toFixed(0)}`,

    text: lines.join("\n")
  });
}

/*
 * =========================
 * ESTADO
 * =========================
 */

let state;

try {
  state = JSON.parse(
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

try {

  /*
   * =========================
   * RADAR
   * =========================
   *
   * 5 aeropuertos × 3 duraciones
   * = 15 consultas.
   *
   * No hacemos verificaciones extra.
   */

  const radarJobs = [];

  for (const origin of origins) {
    for (const duration of durations) {
      radarJobs.push({
        origin,
        duration
      });
    }
  }

  const radarResults =
    await Promise.allSettled(
      radarJobs.map(
        async ({ origin, duration }) => {

          const destinations =
            await exploreEurope(
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

  const allOffers = [];
  const searchErrors = [];

  radarResults.forEach(
    (result, index) => {

      const job =
        radarJobs[index];

      if (result.status === "rejected") {

        const message =
          `${job.origin.airport} · ${job.duration.label}: ${
            result.reason?.message ||
            "Error desconocido"
          }`;

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
        `✓ ${origin.airport} · ${duration.label}: ${destinations.length} destinos europeos`
      );

      for (const deal of destinations) {

        const offer =
          createOffer(
            origin,
            duration,
            deal
          );

        if (offer) {
          allOffers.push(offer);
        }
      }
    }
  );

  /*
   * =========================
   * ORDENAR POR PRECIO
   * =========================
   */

  allOffers.sort(
    (a, b) =>
      a.price - b.price
  );

  /*
   * =========================
   * QUITAR DUPLICADOS
   * =========================
   *
   * Conservamos distintas fechas.
   *
   * Solo eliminamos resultados exactamente
   * repetidos de origen + destino + fechas.
   */

  const exactMap =
    new Map();

  for (const offer of allOffers) {

    const exactKey = [
      offer.origin,
      offer.destination,
      offer.departure,
      offer.returnDate
    ].join("-");

    const existing =
      exactMap.get(exactKey);

    if (
      !existing ||
      offer.price < existing.price
    ) {
      exactMap.set(
        exactKey,
        offer
      );
    }
  }

  const deduplicatedOffers =
    [...exactMap.values()]
      .sort(
        (a, b) =>
          a.price - b.price
      );

  /*
   * =========================
   * VARIEDAD
   * =========================
   *
   * Evitamos que la web quede llena
   * de 20 ofertas de una misma ruta.
   *
   * Permitimos hasta 3 combinaciones
   * de fechas por origen → destino.
   */

  const routeCounts =
    new Map();

  const currentOffers = [];

  for (const offer of deduplicatedOffers) {

    const routeKey =
      `${offer.origin}-${offer.destination}`;

    const count =
      routeCounts.get(routeKey) || 0;

    if (count >= 3) {
      continue;
    }

    currentOffers.push(offer);

    routeCounts.set(
      routeKey,
      count + 1
    );
  }

  /*
   * Reemplazamos resultados anteriores.
   */

  state.offers =
    currentOffers;

  state.lastRun =
    new Date().toISOString();

  state.lastErrors =
    searchErrors;

  /*
   * =========================
   * ALERTAS EMAIL
   * =========================
   */

  const alertCandidates =
    currentOffers
      .filter(
        offer =>
          offer.price <= EMAIL_MAX_PRICE ||
          (
            offer.direct &&
            offer.price <= DIRECT_EMAIL_MAX_PRICE
          )
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

  const newest =
    alertCandidates[0];

  let emailSent = false;
  let emailError = null;

  if (newest) {

    try {

      await sendEmail(newest);

      state.alerted[
        newest.key
      ] = {
        price:
          newest.price,

        sentAt:
          new Date().toISOString(),

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
        `⚠️ Correo: ${error.message}`
      );
    }
  }

  /*
   * =========================
   * RESUMEN
   * =========================
   */

  const countByOrigin =
    airport =>
      currentOffers.filter(
        offer =>
          offer.origin === airport
      ).length;

  const directCount =
    currentOffers.filter(
      offer => offer.direct
    ).length;

  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "🌍 EUROTRIP GIRLS — OPORTUNIDADES"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `🔎 Resultados económicos: ${currentOffers.length}`
  );

  console.log(
    `🇦🇷 EZE: ${countByOrigin("EZE")}`
  );

  console.log(
    `🇦🇷 AEP: ${countByOrigin("AEP")}`
  );

  console.log(
    `🇨🇱 SCL: ${countByOrigin("SCL")}`
  );

  console.log(
    `🇧🇷 GRU: ${countByOrigin("GRU")}`
  );

  console.log(
    `🇧🇷 GIG: ${countByOrigin("GIG")}`
  );

  console.log(
    `✈️ Directas: ${directCount}`
  );

  console.log(
    `🔗 Con link: ${
      currentOffers.filter(
        offer => Boolean(offer.url)
      ).length
    }`
  );

  console.log(
    `📧 Correo enviado: ${
      emailSent
        ? "sí"
        : "no"
    }`
  );

  console.log(
    `⚠️ Búsquedas con error: ${searchErrors.length}`
  );

  if (emailError) {
    console.log(
      `⚠️ Error correo: ${emailError}`
    );
  }

  if (currentOffers.length) {

    const cheapest =
      currentOffers[0];

    console.log(
      `💰 Más barata: ${cheapest.route} · USD ${cheapest.price} · ${cheapest.tripDays ?? "?"} días`
    );
  }

  console.log(
    "=========================================="
  );

} catch (error) {

  state.lastRun =
    new Date().toISOString();

  state.lastErrors = [
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
