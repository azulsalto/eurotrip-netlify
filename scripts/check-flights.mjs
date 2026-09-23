import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const WEBSITE_MAX_PRICE = 1000;
const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;

/*
 * AEROPUERTOS DE SALIDA
 *
 * Argentina:
 * EZE = Ezeiza
 * AEP = Aeroparque
 *
 * Chile:
 * SCL = Santiago
 *
 * Brasil:
 * GRU = São Paulo
 * GIG = Río de Janeiro
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
 * Exploramos dos ventanas distintas para encontrar
 * más oportunidades.
 *
 * La duración NO se utiliza después como filtro.
 */
const durations = [
  {
    value: "1",
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
  params.set(
    "api_key",
    required("SERPAPI_KEY")
  );

  const response = await fetch(
    `https://serpapi.com/search.json?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `SerpApi HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}

/*
 * =========================
 * 1. DESCUBRIMIENTO EUROPA
 * =========================
 */

async function exploreEurope(origin, duration) {
  const params = new URLSearchParams({
    engine: "google_travel_explore",

    departure_id: origin.airport,

    /*
     * Europa
     */
    arrival_area_id: "/m/02j9z",

    type: "1",

    month: "0",

    travel_duration: duration.value,

    travel_class: "1",

    adults: "1",

    currency: "USD",

    max_price: String(WEBSITE_MAX_PRICE),

    travel_mode: "1",

    hl: "en",

    gl: origin.gl
  });

  const data =
    await serpApi(params);

  return Array.isArray(
    data.destinations
  )
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

function getRadarPrice(deal) {
  const price =
    Number(
      deal.flight_price ??
      deal.price
    );

  return Number.isFinite(price)
    ? price
    : null;
}

function calculateTripDays(
  departure,
  returnDate
) {
  if (
    !departure ||
    !returnDate
  ) {
    return null;
  }

  const start =
    new Date(
      `${departure}T12:00:00Z`
    );

  const end =
    new Date(
      `${returnDate}T12:00:00Z`
    );

  const days =
    Math.round(
      (end - start) /
      (
        1000 *
        60 *
        60 *
        24
      )
    );

  return Number.isFinite(days)
    ? days
    : null;
}

/*
 * =========================
 * 2. VERIFICACIÓN
 * =========================
 *
 * Tomamos una ruta encontrada por Explore y
 * hacemos una búsqueda específica para obtener
 * el vuelo y el link.
 */

async function getRealFlight(
  origin,
  deal
) {
  const destination =
    getDestinationCode(deal);

  if (
    !destination ||
    !deal.start_date ||
    !deal.end_date
  ) {
    return null;
  }

  const params =
    new URLSearchParams({
      engine:
        "google_travel_explore",

      departure_id:
        origin.airport,

      arrival_id:
        destination,

      type:
        "1",

      start_date:
        deal.start_date,

      end_date:
        deal.end_date,

      travel_class:
        "1",

      adults:
        "1",

      currency:
        "USD",

      travel_mode:
        "1",

      hl:
        "en",

      gl:
        origin.gl
    });

  const data =
    await serpApi(params);

  const flights =
    Array.isArray(data.flights)
      ? data.flights
      : [];

  /*
   * Buscamos vuelos que tengan precio.
   */
  const validFlights =
    flights
      .filter(
        flight =>
          Number.isFinite(
            Number(
              flight.price
            )
          )
      )
      .sort(
        (a,b) =>
          Number(a.price) -
          Number(b.price)
      );

  const flight =
    validFlights[0];

  if (!flight) {
    return null;
  }

  /*
   * Confirmamos origen real.
   */
  const realOrigin =
    flight.departure_airport?.id ||
    flight.departure_airport?.code ||
    origin.airport;

  const realDestination =
    flight.arrival_airport?.id ||
    flight.arrival_airport?.code ||
    destination;

  /*
   * Si la API devuelve otro origen,
   * descartamos el resultado.
   */
  if (
    realOrigin !==
    origin.airport
  ) {
    return null;
  }

  const price =
    Number(flight.price);

  if (
    !Number.isFinite(price) ||
    price >
      WEBSITE_MAX_PRICE
  ) {
    return null;
  }

  const rawStops =
    flight.number_of_stops ??
    flight.stops;

  const stops =
    rawStops === null ||
    rawStops === undefined ||
    rawStops === ""
      ? null
      : Number(rawStops);

  /*
   * Link específico devuelto por la consulta.
   */
  const googleFlightsLink =
    flight.google_flights_link ||
    data.google_flights_link ||
    null;

  /*
   * No publicamos ofertas sin link.
   */
  if (!googleFlightsLink) {
    return null;
  }

  const tripDays =
    calculateTripDays(
      deal.start_date,
      deal.end_date
    );

  return {
    key: [
      realOrigin,
      realDestination,
      deal.start_date,
      deal.end_date
    ].join("-"),

    origin:
      realOrigin,

    originCity:
      origin.city,

    originCountry:
      origin.country,

    originFlag:
      origin.flag,

    destination:
      realDestination,

    destinationName:
      deal.name ||
      realDestination,

    country:
      deal.country ||
      "Europa",

    route:
      `${realOrigin} → ${realDestination}`,

    departure:
      deal.start_date,

    returnDate:
      deal.end_date,

    tripDays,

    roundTrip:
      true,

    tripType:
      "round_trip",

    tripTypeLabel:
      "Ida y vuelta",

    price,

    airlines:
      flight.airline ||
      flight.airlines ||
      "Aerolínea por confirmar",

    airlineCode:
      flight.airline_code ||
      null,

    stops:
      Number.isFinite(stops)
        ? stops
        : null,

    direct:
      stops === 0,

    flightDuration:
      flight.duration ||
      null,

    source:
      "Google Travel Explore / SerpApi",

    url:
      googleFlightsLink,

    verified:
      true,

    foundToday:
      true,

    foundAt:
      new Date()
        .toISOString()
  };
}

/*
 * =========================
 * EMAIL
 * =========================
 */

async function sendEmail(result) {
  const user =
    required("EMAIL_USER");

  const transporter =
    nodemailer.createTransport({
      host:
        "smtp.gmail.com",

      port:
        465,

      secure:
        true,

      auth: {
        user,

        pass:
          required(
            "EMAIL_APP_PASSWORD"
          )
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
    `Ver en Google Flights: ${result.url}`
  ];

  await transporter.sendMail({
    from:
      `Eurotrip Girls <${user}>`,

    to:
      required("EMAIL_TO"),

    subject:
      result.direct

        ? `✈️ DIRECTO ${result.route} · USD ${result.price.toFixed(0)}`

        : `🔥 ${result.route} · USD ${result.price.toFixed(0)}`,

    text:
      lines.join("\n")
  });
}

/*
 * =========================
 * ESTADO
 * =========================
 */

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

try {

  /*
   * =========================
   * RADAR
   * =========================
   */

  const radarJobs = [];

  for (
    const origin of origins
  ) {
    for (
      const duration of durations
    ) {
      radarJobs.push({
        origin,
        duration
      });
    }
  }

  const radarResults =
    await Promise.allSettled(
      radarJobs.map(
        async ({
          origin,
          duration
        }) => {

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

  const candidates = [];
  const searchErrors = [];

  radarResults.forEach(
    (result,index) => {

      const job =
        radarJobs[index];

      if (
        result.status ===
        "rejected"
      ) {

        const message =
          `${job.origin.airport} · ${job.duration.label}: ${
            result.reason?.message ||
            "Error desconocido"
          }`;

        searchErrors.push(
          message
        );

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

      for (
        const deal of destinations
      ) {

        const destination =
          getDestinationCode(
            deal
          );

        const price =
          getRadarPrice(
            deal
          );

        if (
          !destination ||
          !deal.start_date ||
          !deal.end_date ||
          price === null ||
          price >
            WEBSITE_MAX_PRICE
        ) {
          continue;
        }

        candidates.push({
          origin,
          duration,
          deal,
          destination,
          radarPrice:
            price
        });
      }
    }
  );

  /*
   * =========================
   * PRIORIZAR PRECIO
   * =========================
   */

  candidates.sort(
    (a,b) =>
      a.radarPrice -
      b.radarPrice
  );

  /*
   * No verificamos dos veces la misma
   * ruta origen → destino.
   *
   * Si hay varias fechas de EZE → MAD,
   * elegimos la más barata.
   */

  const bestRouteCandidates =
    new Map();

  for (
    const candidate of candidates
  ) {

    const routeKey =
      `${candidate.origin.airport}-${candidate.destination}`;

    const existing =
      bestRouteCandidates.get(
        routeKey
      );

    if (
      !existing ||
      candidate.radarPrice <
        existing.radarPrice
    ) {
      bestRouteCandidates.set(
        routeKey,
        candidate
      );
    }
  }

  const uniqueCandidates =
    [...bestRouteCandidates.values()]
      .sort(
        (a,b) =>
          a.radarPrice -
          b.radarPrice
      );

  /*
   * =========================
   * SELECCIÓN
   * =========================
   *
   * Primero intentamos conseguir
   * una opción económica desde cada
   * aeropuerto.
   *
   * Después completamos con las
   * oportunidades más baratas.
   */

  const selected = [];
  const selectedRoutes =
    new Set();

  for (
    const origin of origins
  ) {

    const candidate =
      uniqueCandidates.find(
        x =>
          x.origin.airport ===
            origin.airport &&
          !selectedRoutes.has(
            `${x.origin.airport}-${x.destination}`
          )
      );

    if (candidate) {

      const routeKey =
        `${candidate.origin.airport}-${candidate.destination}`;

      selected.push(
        candidate
      );

      selectedRoutes.add(
        routeKey
      );
    }
  }

  /*
   * Máximo 8 verificaciones.
   *
   * Ya tenemos hasta 5 reservadas:
   * EZE / AEP / SCL / GRU / GIG.
   *
   * Las restantes son simplemente
   * las oportunidades más económicas.
   */

  for (
    const candidate of
      uniqueCandidates
  ) {

    if (
      selected.length >= 8
    ) {
      break;
    }

    const routeKey =
      `${candidate.origin.airport}-${candidate.destination}`;

    if (
      selectedRoutes.has(
        routeKey
      )
    ) {
      continue;
    }

    selected.push(
      candidate
    );

    selectedRoutes.add(
      routeKey
    );
  }

  console.log("");

  console.log(
    `🔎 Rutas económicas a verificar: ${selected.length}`
  );

  for (
    const candidate of selected
  ) {
    console.log(
      `   ${candidate.origin.airport} → ${candidate.destination} · radar USD ${candidate.radarPrice}`
    );
  }

  /*
   * =========================
   * VERIFICAR
   * =========================
   */

  const verificationResults =
    await Promise.allSettled(
      selected.map(
        async candidate => {

          const verified =
            await getRealFlight(
              candidate.origin,
              candidate.deal
            );

          return verified;
        }
      )
    );

  const verifiedOffers = [];

  verificationResults.forEach(
    (
      result,
      index
    ) => {

      const candidate =
        selected[index];

      if (
        result.status ===
        "fulfilled" &&
        result.value
      ) {

        verifiedOffers.push(
          result.value
        );

        console.log(
          `✓ Verificada ${result.value.route} · USD ${result.value.price}`
        );

        return;
      }

      if (
        result.status ===
        "rejected"
      ) {

        console.warn(
          `⚠️ No se pudo verificar ${candidate.origin.airport} → ${candidate.destination}: ${
            result.reason?.message ||
            "Error"
          }`
        );

        return;
      }

      console.warn(
        `⚠️ ${candidate.origin.airport} → ${candidate.destination} no produjo una oferta verificable`
      );
    }
  );

  /*
   * =========================
   * ELIMINAR DUPLICADOS
   * =========================
   */

  const uniqueMap =
    new Map();

  for (
    const offer of
      verifiedOffers
  ) {

    const routeKey =
      `${offer.origin}-${offer.destination}`;

    const existing =
      uniqueMap.get(
        routeKey
      );

    /*
     * Conservamos la oferta más barata
     * de cada ruta.
     */
    if (
      !existing ||
      offer.price <
        existing.price
    ) {

      uniqueMap.set(
        routeKey,
        offer
      );
    }
  }

  const currentOffers =
    [...uniqueMap.values()]
      .sort(
        (a,b) =>
          a.price -
          b.price
      );

  /*
   * Reemplazamos las ofertas anteriores
   * por las de esta búsqueda.
   */

  state.offers =
    currentOffers;

  state.lastRun =
    new Date()
      .toISOString();

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
          offer.price <=
            EMAIL_MAX_PRICE ||

          (
            offer.direct &&
            offer.price <=
              DIRECT_EMAIL_MAX_PRICE
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
        (a,b) =>
          a.price -
          b.price
      );

  const newest =
    alertCandidates[0];

  let emailSent =
    false;

  let emailError =
    null;

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

      emailSent =
        true;

    } catch(error) {

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

  const eze =
    currentOffers.filter(
      x => x.origin === "EZE"
    ).length;

  const aep =
    currentOffers.filter(
      x => x.origin === "AEP"
    ).length;

  const scl =
    currentOffers.filter(
      x => x.origin === "SCL"
    ).length;

  const gru =
    currentOffers.filter(
      x => x.origin === "GRU"
    ).length;

  const gig =
    currentOffers.filter(
      x => x.origin === "GIG"
    ).length;

  const directCount =
    currentOffers.filter(
      x => x.direct
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
    `✅ Ofertas verificadas: ${currentOffers.length}`
  );

  console.log(
    `🇦🇷 EZE: ${eze}`
  );

  console.log(
    `🇦🇷 AEP: ${aep}`
  );

  console.log(
    `🇨🇱 SCL: ${scl}`
  );

  console.log(
    `🇧🇷 GRU: ${gru}`
  );

  console.log(
    `🇧🇷 GIG: ${gig}`
  );

  console.log(
    `✈️ Directas: ${directCount}`
  );

  console.log(
    `🔗 Con link: ${
      currentOffers.filter(
        x => Boolean(x.url)
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
    `⚠️ Búsquedas radar con error: ${searchErrors.length}`
  );

  if (emailError) {

    console.log(
      `⚠️ Error correo: ${emailError}`
    );
  }

  if (
    currentOffers.length
  ) {

    const cheapest =
      currentOffers[0];

    console.log(
      `💰 Más barata: ${cheapest.route} · USD ${cheapest.price}`
    );
  }

  console.log(
    "=========================================="
  );

} catch(error) {

  state.lastRun =
    new Date()
      .toISOString();

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
