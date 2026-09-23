import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const WEBSITE_MAX_PRICE = 1000;
const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;

// Radar de largo plazo.
// 15 búsquedas flexibles + solamente 2 búsquedas futuras por corrida.
const FUTURE_PROBES_PER_RUN = 2;
const FUTURE_TARGET_YEAR = 2028;
const FUTURE_TRIP_DAYS = 14;
const FUTURE_STEP_DAYS = 30;

/*
 * EUROTRIP GIRLS
 *
 * Objetivo:
 * encontrar oportunidades económicas ida y vuelta a Europa.
 *
 * La duración NO es un filtro de calidad.
 * El precio es nuestra prioridad.
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
 * RADAR FLEXIBLE
 * =========================
 */

async function exploreEurope(origin, duration) {
  const params = new URLSearchParams({
    engine: "google_travel_explore",
    departure_id: origin.airport,
    arrival_area_id: "/m/02j9z",
    type: "1",

    // Todos los meses disponibles dentro
    // del horizonte flexible de Explore.
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

  const data = await serpApi(params);

  return Array.isArray(data.destinations)
    ? data.destinations
    : [];
}

/*
 * =========================
 * RADAR FUTURO
 * =========================
 */

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);

  copy.setUTCDate(
    copy.getUTCDate() + days
  );

  return copy;
}

function futureSearchStart() {
  const today = new Date();

  today.setUTCHours(
    12,
    0,
    0,
    0
  );

  // Empezamos un poco después del horizonte
  // que ya cubre el radar flexible.
  const start = new Date(today);

  start.setUTCMonth(
    start.getUTCMonth() + 7
  );

  start.setUTCDate(15);

  return start;
}

function futureSearchLimit() {
  return new Date(
    `${FUTURE_TARGET_YEAR}-12-15T12:00:00Z`
  );
}

function buildFutureProbe(state) {
  const start =
    futureSearchStart();

  const limit =
    futureSearchLimit();

  let cursor =
    state.futureRadar?.cursor
      ? new Date(
          `${state.futureRadar.cursor}T12:00:00Z`
        )
      : start;

  if (
    Number.isNaN(cursor.getTime()) ||
    cursor < start ||
    cursor > limit
  ) {
    cursor = start;
  }

  return cursor;
}

async function exploreEuropeByDates(
  origin,
  outboundDate,
  returnDate
) {
  const params =
    new URLSearchParams({
      engine: "google_travel_explore",
      departure_id: origin.airport,
      arrival_area_id: "/m/02j9z",
      type: "1",

      outbound_date: outboundDate,
      return_date: returnDate,

      travel_class: "1",
      adults: "1",
      currency: "USD",
      max_price: String(
        WEBSITE_MAX_PRICE
      ),
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

function getPrice(deal) {
  const price = Number(
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
  if (!departure || !returnDate) {
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
 * CREAR OFERTA
 * =========================
 */

function createOffer(
  origin,
  duration,
  deal,
  radarType = "flexible"
) {
  const destination =
    getDestinationCode(deal);

  const price =
    getPrice(deal);

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

  const stops =
    normalizeStops(
      deal.number_of_stops ??
      deal.stops
    );

  const tripDays =
    calculateTripDays(
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

    origin:
      origin.airport,

    originCity:
      origin.city,

    originCountry:
      origin.country,

    originFlag:
      origin.flag,

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

    tripType:
      "round_trip",

    tripTypeLabel:
      "Ida y vuelta",

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

    // Se conserva por compatibilidad
    // con la web actual.
    verified: true,

    roundTripVerified: true,

    durationSearch:
      duration.label,

    radarType,

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
   * RADAR PRINCIPAL
   * =========================
   */

  const radarJobs = [];

  for (const origin of origins) {
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

  const allOffers = [];
  const searchErrors = [];

  radarResults.forEach(
    (result, index) => {

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
        const offer =
          createOffer(
            origin,
            duration,
            deal,
            "flexible"
          );

        if (offer) {
          allOffers.push(
            offer
          );
        }
      }
    }
  );

  /*
   * =========================
   * RADAR FUTURO
   * =========================
   */

  state.futureRadar ||= {
    cursor: null,
    originIndex: 0
  };

  let futureCursor =
    buildFutureProbe(state);

  let futureOriginIndex =
    Number(
      state.futureRadar.originIndex
    ) || 0;

  const futureLimit =
    futureSearchLimit();

  const futureJobs = [];

  for (
    let i = 0;
    i < FUTURE_PROBES_PER_RUN;
    i++
  ) {

    if (
      futureCursor > futureLimit
    ) {
      futureCursor =
        futureSearchStart();
    }

    const origin =
      origins[
        futureOriginIndex %
        origins.length
      ];

    const outboundDate =
      isoDate(futureCursor);

    const returnDate =
      isoDate(
        addDays(
          futureCursor,
          FUTURE_TRIP_DAYS
        )
      );

    futureJobs.push({
      origin,
      outboundDate,
      returnDate
    });

    futureOriginIndex++;

    if (
      futureOriginIndex %
      origins.length === 0
    ) {
      futureCursor =
        addDays(
          futureCursor,
          FUTURE_STEP_DAYS
        );
    }
  }

  const futureResults =
    await Promise.allSettled(
      futureJobs.map(
        async ({
          origin,
          outboundDate,
          returnDate
        }) => {

          const destinations =
            await exploreEuropeByDates(
              origin,
              outboundDate,
              returnDate
            );

          return {
            origin,
            outboundDate,
            returnDate,
            destinations
          };
        }
      )
    );

  futureResults.forEach(
    (result, index) => {

      const job =
        futureJobs[index];

      if (
        result.status ===
        "rejected"
      ) {

        const message =
          `FUTURO ${job.origin.airport} · ${job.outboundDate}: ${
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
        outboundDate,
        returnDate,
        destinations
      } = result.value;

      console.log(
        `🔭 FUTURO ${origin.airport} · ${outboundDate} → ${returnDate}: ${destinations.length} destinos europeos`
      );

      const futureDuration = {
        value: "future",
        label:
          `Largo plazo · ${outboundDate} → ${returnDate}`
      };

      for (
        const deal of destinations
      ) {

        const normalizedDeal = {
          ...deal,

          start_date:
            deal.start_date ||
            outboundDate,

          end_date:
            deal.end_date ||
            returnDate
        };

        const offer =
          createOffer(
            origin,
            futureDuration,
            normalizedDeal,
            "future"
          );

        if (offer) {
          allOffers.push(
            offer
          );
        }
      }
    }
  );

  state.futureRadar = {
    cursor:
      isoDate(futureCursor),

    originIndex:
      futureOriginIndex
  };

  /*
   * Conservamos oportunidades futuras
   * encontradas en corridas anteriores.
   */

  const todayIso =
    new Date()
      .toISOString()
      .slice(0, 10);

  const savedFutureOffers =
    Array.isArray(state.offers)
      ? state.offers.filter(
          offer =>
            offer.radarType ===
              "future" &&

            offer.departure >=
              todayIso &&

            Number(
              offer.price
            ) <=
              WEBSITE_MAX_PRICE &&

            Boolean(
              offer.url
            )
        )
      : [];

  allOffers.push(
    ...savedFutureOffers
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
   * Eliminamos únicamente resultados
   * exactamente repetidos:
   * origen + destino + ida + vuelta.
   *
   * Si tenemos dos iguales,
   * conservamos el más barato.
   */

  const exactMap =
    new Map();

  for (
    const offer of allOffers
  ) {

    const exactKey = [
      offer.origin,
      offer.destination,
      offer.departure,
      offer.returnDate
    ].join("-");

    const existing =
      exactMap.get(
        exactKey
      );

    if (
      !existing ||
      offer.price <
        existing.price
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
   * Permitimos hasta 3 fechas
   * diferentes por cada ruta.
   *
   * Ejemplo:
   *
   * SCL → MAD
   *
   * puede aparecer hasta
   * tres veces si son fechas
   * distintas.
   */

  const routeCounts =
    new Map();

  const currentOffers = [];

  for (
    const offer of
      deduplicatedOffers
  ) {

    const routeKey =
      `${offer.origin}-${offer.destination}`;

    const count =
      routeCounts.get(
        routeKey
      ) || 0;

    if (
      count >= 3
    ) {
      continue;
    }

    currentOffers.push(
      offer
    );

    routeCounts.set(
      routeKey,
      count + 1
    );
  }

  /*
   * =========================
   * GUARDAR RESULTADOS
   * =========================
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
   *
   * Mandamos alerta cuando:
   *
   * - precio <= USD 800
   *
   * O
   *
   * - vuelo directo
   *   precio <= USD 900
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
        (a, b) =>
          a.price - b.price
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
          offer.origin ===
            airport
      ).length;

  const directCount =
    currentOffers.filter(
      offer =>
        offer.direct
    ).length;

  const futureCount =
    currentOffers.filter(
      offer =>
        offer.radarType ===
          "future"
    ).length;

  const flexibleCount =
    currentOffers.filter(
      offer =>
        offer.radarType !==
          "future"
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
    `🗓️ Radar flexible: ${flexibleCount}`
  );

  console.log(
    `🔭 Largo plazo guardadas: ${futureCount}`
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
        offer =>
          Boolean(
            offer.url
          )
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
    `🔭 Sondas futuras ejecutadas: ${futureJobs.length}`
  );

  console.log(
    `🗓️ Próximo cursor futuro: ${state.futureRadar.cursor}`
  );

  console.log(
    `⚠️ Búsquedas con error: ${searchErrors.length}`
  );

  if (emailError) {

    console.log(
      `⚠️ Error correo: ${emailError}`
    );
  }

  if (
    searchErrors.length
  ) {

    console.log("");

    console.log(
      "Detalle de errores:"
    );

    for (
      const error of
        searchErrors
    ) {
      console.log(
        `- ${error}`
      );
    }
  }

  if (
    currentOffers.length
  ) {

    const cheapest =
      currentOffers[0];

    console.log("");

    console.log(
      `💰 Más barata: ${cheapest.route} · USD ${cheapest.price} · ${cheapest.tripDays ?? "?"} días`
    );

    const furthest =
      [...currentOffers]
        .sort(
          (a, b) =>
            String(
              b.departure
            ).localeCompare(
              String(
                a.departure
              )
            )
        )[0];

    if (furthest) {

      console.log(
        `🔭 Fecha más lejana encontrada: ${furthest.departure} · ${furthest.route} · USD ${furthest.price}`
      );
    }
  }

  console.log(
    "=========================================="
  );

} catch (error) {

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

  /*
   * Guardamos results.json
   * aunque falle alguna parte,
   * para conservar el estado
   * del radar futuro.
   */

  await fs.writeFile(
    STATE_FILE,

    JSON.stringify(
      state,
      null,
      2
    ) + "\n"
  );
}
