import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const WEBSITE_MAX_PRICE = 1000;
const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;

/*
 * RADAR EUROPA
 *
 * Primera etapa:
 * Google Travel Explore encuentra oportunidades SOLO hacia Europa.
 *
 * Segunda etapa:
 * Consultamos el destino concreto para obtener el vuelo real
 * y el enlace específico de Google Flights.
 *
 * IMPORTANTE:
 * Usamos aeropuertos individualmente porque la búsqueda agrupada
 * de Argentina ya comprobamos que devuelve vacío.
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
 * 1 = una semana
 * 3 = dos semanas
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
    `https://serpapi.com/search.json?${params}`
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
 * ETAPA 1
 *
 * Descubrimos destinos dentro de Europa.
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

  const data = await serpApi(params);

  return data.destinations || [];
}

/*
 * ETAPA 2
 *
 * Ahora que conocemos un destino concreto,
 * pedimos los vuelos reales de esa ruta.
 */
async function getRealFlight(origin, deal) {
  const destination =
    deal.destination_airport?.code;

  if (
    !destination ||
    !deal.start_date ||
    !deal.end_date
  ) {
    return null;
  }

  const params = new URLSearchParams({
    engine: "google_travel_explore",

    departure_id: origin.airport,

    arrival_id: destination,

    type: "1",

    start_date: deal.start_date,

    end_date: deal.end_date,

    travel_class: "1",

    adults: "1",

    currency: "USD",

    travel_mode: "1",

    hl: "en",

    gl: origin.gl
  });

  const data = await serpApi(params);

  const flights =
    Array.isArray(data.flights)
      ? data.flights
      : [];

  if (!flights.length) {
    return null;
  }

  /*
   * Preferimos el vuelo más barato.
   */
  const sorted = flights
    .filter(flight =>
      Number.isFinite(
        Number(flight.price)
      )
    )
    .sort(
      (a, b) =>
        Number(a.price) -
        Number(b.price)
    );

  const flight = sorted[0];

  if (!flight) {
    return null;
  }

  const realOrigin =
    flight.departure_airport?.id;

  const realDestination =
    flight.arrival_airport?.id;

  /*
   * Seguridad:
   * la segunda consulta tiene que confirmar
   * exactamente el aeropuerto de salida
   * que buscamos.
   */
  if (
    realOrigin !== origin.airport ||
    !realDestination
  ) {
    return null;
  }

  const price =
    Number(flight.price);

  if (
    !Number.isFinite(price) ||
    price > WEBSITE_MAX_PRICE
  ) {
    return null;
  }

  const stops =
    flight.number_of_stops === null ||
    flight.number_of_stops === undefined
      ? null
      : Number(
          flight.number_of_stops
        );

  const googleFlightsLink =
    data.google_flights_link ||
    null;

  /*
   * Sin enlace específico no publicamos.
   */
  if (!googleFlightsLink) {
    return null;
  }

  return {
    key: [
      realOrigin,
      realDestination,
      deal.start_date,
      deal.end_date
    ].join("-"),

    origin: realOrigin,

    originCity: origin.city,

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

    roundTrip: true,

    tripType:
      "round_trip",

    tripTypeLabel:
      "Ida y vuelta",

    price,

    airlines:
      flight.airline ||
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

    duration:
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
      new Date().toISOString()
  };
}

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

  const lines = [
    "✈️ EUROTRIP GIRLS",
    "",
    `${result.originFlag} ${result.route}`,
    "",
    `${result.destinationName}, ${result.country}`,
    "",
    `Ida: ${result.departure}`,
    `Vuelta: ${result.returnDate}`,
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
   * ETAPA 1 — RADAR
   * =========================
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

      /*
       * Solo guardamos oportunidades
       * de hasta USD 1000.
       */
      for (
        const deal of destinations
      ) {
        const price =
          Number(
            deal.flight_price
          );

        if (
          !Number.isFinite(price) ||
          price >
            WEBSITE_MAX_PRICE
        ) {
          continue;
        }

        if (
          !deal.destination_airport?.code ||
          !deal.start_date ||
          !deal.end_date
        ) {
          continue;
        }

        candidates.push({
          origin,
          duration,
          deal,
          radarPrice: price
        });
      }
    }
  );

  /*
   * Ordenamos por precio.
   *
   * IMPORTANTE:
   * No vamos a verificar 150 destinos,
   * porque gastaría demasiadas búsquedas.
   *
   * Verificamos solo las mejores.
   */
  candidates.sort(
    (a,b) =>
      a.radarPrice -
      b.radarPrice
  );

  /*
   * Máximo 6 verificaciones adicionales.
   *
   * Priorizamos que haya representación
   * de los distintos orígenes.
   */
  const selected = [];
  const selectedKeys =
    new Set();

  /*
   * Primero intentamos tomar
   * una buena oportunidad por origen.
   */
  for (const origin of origins) {

    const candidate =
      candidates.find(
        x =>
          x.origin.airport ===
            origin.airport &&
          !selectedKeys.has(
            [
              x.origin.airport,
              x.deal.destination_airport?.code,
              x.deal.start_date,
              x.deal.end_date
            ].join("-")
          )
      );

    if (candidate) {

      const key = [
        candidate.origin.airport,
        candidate.deal.destination_airport?.code,
        candidate.deal.start_date,
        candidate.deal.end_date
      ].join("-");

      selected.push(candidate);
      selectedKeys.add(key);
    }
  }

  /*
   * Completamos hasta 6 con
   * las oportunidades más baratas.
   */
  for (const candidate of candidates) {

    if (selected.length >= 6) {
      break;
    }

    const key = [
      candidate.origin.airport,
      candidate.deal.destination_airport?.code,
      candidate.deal.start_date,
      candidate.deal.end_date
    ].join("-");

    if (
      selectedKeys.has(key)
    ) {
      continue;
    }

    selected.push(candidate);
    selectedKeys.add(key);
  }

  console.log("");
  console.log(
    `🔎 Candidatas a verificar: ${selected.length}`
  );

  /*
   * =========================
   * ETAPA 2 — VERIFICACIÓN
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

          if (!verified) {
            return null;
          }

          verified.duration =
            candidate.duration.label;

          return verified;
        }
      )
    );

  const verifiedOffers = [];

  verificationResults.forEach(
    result => {

      if (
        result.status ===
          "fulfilled" &&
        result.value
      ) {
        verifiedOffers.push(
          result.value
        );
      }

      if (
        result.status ===
        "rejected"
      ) {
        console.warn(
          `⚠️ Verificación: ${
            result.reason?.message ||
            "Error"
          }`
        );
      }
    }
  );

  /*
   * Eliminamos duplicados.
   */
  const uniqueMap =
    new Map();

  for (
    const offer of
      verifiedOffers
  ) {
    const existing =
      uniqueMap.get(
        offer.key
      );

    if (
      !existing ||
      offer.price <
        existing.price
    ) {
      uniqueMap.set(
        offer.key,
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
   * Reemplazamos la web anterior.
   *
   * Esto elimina los vuelos domésticos
   * de Chile que quedaron de Deals.
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
   * EMAIL
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
   * LOG
   * =========================
   */

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
      x => x.direct
    ).length;

  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "🌍 EUROTRIP GIRLS — EUROPA VERIFICADA"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `✅ Ofertas verificadas: ${currentOffers.length}`
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
    `✈️ Directas: ${directCount}`
  );

  console.log(
    `🔗 Con link Google Flights: ${
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
    `⚠️ Radar con error: ${searchErrors.length}`
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
      `💰 Más barata verificada: ${cheapest.route} · USD ${cheapest.price}`
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
