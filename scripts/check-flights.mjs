import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;
const WEBSITE_MAX_PRICE = 1000;

/*
 * IMPORTANTE:
 * Cada búsqueda representa una zona/origen de exploración.
 * NO usamos este aeropuerto para afirmar que el vuelo sale de ahí.
 * El aeropuerto mostrado se toma del resultado devuelto por Google.
 */
const origins = [
  {
    departureId: "EZE,AEP,COR,MDZ,ROS,SLA,TUC,NQN,BRC,IGR,USH",
    fallbackAirport: "ARG",
    city: "Argentina",
    country: "Argentina",
    flag: "🇦🇷",
    gl: "ar"
  },
  {
    departureId: "SCL",
    fallbackAirport: "SCL",
    city: "Santiago",
    country: "Chile",
    flag: "🇨🇱",
    gl: "cl"
  },
  {
    departureId: "GRU",
    fallbackAirport: "GRU",
    city: "São Paulo",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  },
  {
    departureId: "GIG",
    fallbackAirport: "GIG",
    city: "Río de Janeiro",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  }
];

const durations = [
  { value: "2", label: "Una semana" },
  { value: "3", label: "Dos semanas" }
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta el secreto ${name}`);
  return value;
}

async function searchEurope(origin, duration) {
  const query = new URLSearchParams({
    engine: "google_travel_explore",

    // Puede contener varios aeropuertos.
    departure_id: origin.departureId,

    // Europa
    arrival_area_id: "/m/02j9z",

    // 1 = ida y vuelta
    type: "1",

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
    throw new Error(`SerpApi ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data.destinations || [];
}

function getStops(item) {
  const raw =
    item.number_of_stops ??
    item.stops ??
    item.flight?.number_of_stops;

  if (raw === null || raw === undefined || raw === "") {
    return null;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
}

function getAirportCode(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const cleaned = value.trim().toUpperCase();

    // Solo aceptamos códigos IATA.
    if (/^[A-Z]{3}$/.test(cleaned)) return cleaned;

    return null;
  }

  return (
    getAirportCode(value.id) ||
    getAirportCode(value.code) ||
    getAirportCode(value.airport_code)
  );
}

function getRealOrigin(item, searchOrigin) {
  /*
   * Primero buscamos un aeropuerto REAL devuelto por el resultado.
   * Nunca convertimos automáticamente una búsqueda argentina en EZE.
   */
  const candidates = [
    item.departure_airport,
    item.origin_airport,
    item.departure_airport_code,
    item.origin_airport_code,
    item.flight?.departure_airport
  ];

  for (const candidate of candidates) {
    const code = getAirportCode(candidate);
    if (code) return code;
  }

  /*
   * Si la consulta tiene UN SOLO aeropuerto, sí sabemos cuál fue
   * el aeropuerto solicitado.
   */
  if (!searchOrigin.departureId.includes(",")) {
    return searchOrigin.fallbackAirport;
  }

  // Para Argentina agrupada no inventamos EZE/AEP/etc.
  return null;
}

function getDestination(item) {
  return (
    getAirportCode(item.destination_airport) ||
    getAirportCode(item.destination_airport_code) ||
    getAirportCode(item.arrival_airport) ||
    getAirportCode(item.arrival_airport_code)
  );
}

function getGoogleFlightsLink(item) {
  /*
   * Priorizamos enlaces específicos de Google Flights.
   * NO usamos item.link porque puede ser un link genérico de Explore.
   */
  return (
    item.google_flights_link ||
    item.flight?.google_flights_link ||
    null
  );
}

function summarize(item, duration, searchOrigin) {
  const realOrigin = getRealOrigin(item, searchOrigin);
  const destination = getDestination(item);

  if (!realOrigin || !destination) {
    return null;
  }

  const price = Number(item.flight_price);

  if (!Number.isFinite(price)) {
    return null;
  }

  if (!item.start_date || !item.end_date) {
    return null;
  }

  const stops = getStops(item);
  const googleFlightsLink = getGoogleFlightsLink(item);

  return {
    key: [
      realOrigin,
      destination,
      item.start_date,
      item.end_date,
      duration.value
    ].join("-"),

    origin: realOrigin,
    originCity: searchOrigin.city,
    originCountry: searchOrigin.country,
    originFlag: searchOrigin.flag,

    destination,
    destinationName: item.name || destination,
    country: item.country || "Europa",

    route: `${realOrigin} → ${destination}`,

    departure: item.start_date,
    returnDate: item.end_date,

    // Siempre corresponde a búsqueda type=1 (ida y vuelta)
    tripType: "round_trip",
    tripTypeLabel: "Ida y vuelta",

    price,

    airlines:
      item.airline ||
      item.airlines ||
      item.flight?.airline ||
      "Consultar",

    stops,
    direct: stops === 0,

    duration: duration.label,
    season: `Fechas flexibles · ${duration.label}`,

    source: "Google Travel / SerpApi",

    foundAt: new Date().toISOString(),
    foundToday: true,

    previousPrice: null,
    priceDrop: 0,

    /*
     * Si no tenemos link específico NO colocamos el link
     * genérico de Explore como si fuera el itinerario.
     */
    url: googleFlightsLink,

    verifiedRoute: true,
    roundTrip: true
  };
}

async function sendEmail(result) {
  const user = required("EMAIL_USER");

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user,
      pass: required("EMAIL_APP_PASSWORD")
    }
  });

  const direct = result.stops === 0;

  const reason =
    direct && result.price > EMAIL_MAX_PRICE
      ? "✈️ VUELO DIRECTO ENCONTRADO"
      : "🔥 OFERTA DENTRO DE TU PRESUPUESTO";

  const stopsText =
    result.stops === null
      ? "Consultar"
      : result.stops === 0
        ? "Directo"
        : `${result.stops} escala${result.stops > 1 ? "s" : ""}`;

  const lines = [
    reason,
    "",
    `${result.originFlag} Salida: ${result.origin}`,
    "",
    result.route,
    "",
    `Destino: ${result.destinationName}, ${result.country}`,
    `Fechas: ${result.departure} al ${result.returnDate}`,
    "Tipo de viaje: Ida y vuelta",
    `Precio: USD ${result.price.toFixed(2)}`,
    `Aerolínea: ${result.airlines}`,
    `Escalas: ${stopsText}`,
    `Duración: ${result.duration}`,
    `Fuente: ${result.source}`
  ];

  if (result.url) {
    lines.push("", `Ver vuelo: ${result.url}`);
  }

  await transporter.sendMail({
    from: `Eurotrip <${user}>`,
    to: required("EMAIL_TO"),

    subject: direct
      ? `✈️ DIRECTO ${result.route} · USD ${result.price.toFixed(0)}`
      : `🔥 ${result.route} · USD ${result.price.toFixed(0)}`,

    text: lines.join("\n")
  });
}

let state;

try {
  state = JSON.parse(
    await fs.readFile(STATE_FILE, "utf8")
  );
} catch {
  state = {
    offers: [],
    alerted: {}
  };
}

state.alerted ||= {};

try {
  const jobs = [];

  for (const origin of origins) {
    for (const duration of durations) {
      jobs.push({
        origin,
        duration
      });
    }
  }

  const results = await Promise.allSettled(
    jobs.map(async ({ origin, duration }) => {
      const destinations = await searchEurope(
        origin,
        duration
      );

      return {
        origin,
        duration,
        destinations
      };
    })
  );

  const found = [];
  const searchErrors = [];

  results.forEach((result, index) => {
    const job = jobs[index];

    if (result.status === "rejected") {
      const message =
        `${job.origin.city} · ${job.duration.label}: ` +
        `${result.reason?.message || "Error desconocido"}`;

      searchErrors.push(message);

      console.warn(`⚠️ ${message}`);
      return;
    }

    const {
      origin,
      duration,
      destinations
    } = result.value;

    console.log(
      `✓ ${origin.city} · ${duration.label}: ` +
      `${destinations.length} destinos`
    );

    for (const item of destinations) {
      const offer = summarize(
        item,
        duration,
        origin
      );

      /*
       * Si no podemos determinar el aeropuerto real,
       * NO publicamos la oferta.
       */
      if (!offer) continue;

      found.push(offer);
    }
  });

  if (
    found.length === 0 &&
    searchErrors.length === jobs.length
  ) {
    throw new Error(
      "Fallaron todas las búsquedas de vuelos."
    );
  }

  const today =
    new Date().toISOString().slice(0, 10);

  const validOffers = found.filter(
    offer =>
      offer.roundTrip === true &&
      offer.departure >= today &&
      offer.returnDate >= offer.departure &&
      Number.isFinite(Number(offer.price)) &&
      offer.price <= WEBSITE_MAX_PRICE
  );

  const uniqueMap = new Map();

  for (const offer of validOffers) {
    const duplicateKey = [
      offer.origin,
      offer.destination,
      offer.departure,
      offer.returnDate
    ].join("-");

    const existing =
      uniqueMap.get(duplicateKey);

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

  const currentOffers =
    [...uniqueMap.values()]
      .sort((a, b) => a.price - b.price)
      .slice(0, 200);

  state.offers = currentOffers;
  state.lastRun = new Date().toISOString();
  state.lastErrors = searchErrors;

  const alertCandidates =
    currentOffers
      .filter(offer => {
        const normalDeal =
          offer.price <= EMAIL_MAX_PRICE;

        const directDeal =
          offer.stops === 0 &&
          offer.price <= DIRECT_EMAIL_MAX_PRICE;

        return normalDeal || directDeal;
      })
      .filter(offer => {
        const previous =
          state.alerted[offer.key];

        return (
          !previous ||
          offer.price < previous.price
        );
      })
      .sort((a, b) => a.price - b.price);

  const newest = alertCandidates[0];

  let emailSent = false;
  let emailError = null;

  if (newest) {
    try {
      await sendEmail(newest);

      state.alerted[newest.key] = {
        price: newest.price,
        sentAt: new Date().toISOString(),
        origin: newest.origin,
        destination: newest.destination
      };

      emailSent = true;
    } catch (error) {
      emailError = error.message;

      console.warn(
        `⚠️ No se pudo enviar el correo: ${error.message}`
      );
    }
  }

  const argentina =
    currentOffers.filter(
      x => x.originCountry === "Argentina"
    ).length;

  const chile =
    currentOffers.filter(
      x => x.originCountry === "Chile"
    ).length;

  const brasil =
    currentOffers.filter(
      x => x.originCountry === "Brasil"
    ).length;

  const directCount =
    currentOffers.filter(
      x => x.stops === 0
    ).length;

  const withSpecificLink =
    currentOffers.filter(
      x => Boolean(x.url)
    ).length;

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "🌍 EUROTRIP — RESULTADO"
  );
  console.log(
    "=========================================="
  );

  console.log(
    `Ofertas ida y vuelta válidas: ${currentOffers.length}`
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
    `🔗 Con link específico: ${withSpecificLink}`
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
      `💰 Más barata: ${cheapest.route} · ` +
      `USD ${cheapest.price} · IDA Y VUELTA`
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
    JSON.stringify(state, null, 2) + "\n"
  );
}
