import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

const WEBSITE_MAX_PRICE = 1000;
const EMAIL_MAX_PRICE = 800;
const DIRECT_EMAIL_MAX_PRICE = 900;

/*
 * Google Flights Deals permite múltiples aeropuertos
 * separados por coma.
 *
 * Hacemos 3 búsquedas:
 * Argentina / Chile / Brasil
 */
const searches = [
  {
    departureId: "EZE,AEP,COR,MDZ,ROS",
    country: "Argentina",
    flag: "🇦🇷",
    gl: "ar"
  },
  {
    departureId: "SCL",
    country: "Chile",
    flag: "🇨🇱",
    gl: "cl"
  },
  {
    departureId: "GRU,GIG",
    country: "Brasil",
    flag: "🇧🇷",
    gl: "br"
  }
];

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Falta el secreto ${name}`);
  }

  return value;
}

async function searchDeals(search) {
  const query = new URLSearchParams({
    engine: "google_flights_deals",

    departure_id: search.departureId,

    type: "1",

    trip_length: "7,15",

    travel_class: "1",

    currency: "USD",

    max_price: String(WEBSITE_MAX_PRICE),

    hl: "es",

    gl: search.gl,

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

  return data.deals || [];
}

function daysBetween(start, end) {
  const a = new Date(`${start}T12:00:00Z`);
  const b = new Date(`${end}T12:00:00Z`);

  return Math.round(
    (b - a) / (1000 * 60 * 60 * 24)
  );
}

function normalizeDeal(item, search) {
  const origin =
    item.departure_airport_code;

  const destination =
    item.arrival_airport_code;

  const departure =
    item.start_date ||
    item.outbound_date;

  const returnDate =
    item.end_date ||
    item.return_date;

  const price =
    Number(item.price);

  if (
    !origin ||
    !destination ||
    !departure ||
    !returnDate ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  const stops =
    item.stops === null ||
    item.stops === undefined
      ? null
      : Number(item.stops);

  const tripDays =
    daysBetween(
      departure,
      returnDate
    );

  /*
   * Seguridad adicional:
   * solamente aceptamos viajes
   * entre 7 y 15 días.
   */
  if (
    tripDays < 7 ||
    tripDays > 15
  ) {
    return null;
  }

  return {
    key: [
      origin,
      destination,
      departure,
      returnDate
    ].join("-"),

    origin,

    originCountry:
      search.country,

    originFlag:
      search.flag,

    destination,

    destinationName:
      item.name ||
      destination,

    country:
      item.country ||
      "Europa",

    route:
      `${origin} → ${destination}`,

    departure,

    returnDate,

    tripDays,

    roundTrip: true,

    tripType:
      "round_trip",

    tripTypeLabel:
      "Ida y vuelta",

    price,

    airlines:
      item.airline ||
      "Aerolínea por confirmar",

    airlineCode:
      item.airline_code ||
      null,

    stops:
      Number.isFinite(stops)
        ? stops
        : null,

    direct:
      stops === 0,

    flightDuration:
      item.flight_duration ||
      null,

    /*
     * ESTE es el link que devuelve
     * Google Flights Deals.
     */
    url:
      item.flight_link ||
      null,

    /*
     * Solo consideramos verificable
     * una tarjeta si tenemos link.
     */
    verified:
      Boolean(item.flight_link),

    source:
      "Google Flights Deals / SerpApi",

    foundAt:
      new Date().toISOString(),

    foundToday:
      true
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
    `Duración: ${result.tripDays} días`,
    "",
    `Precio ida y vuelta: USD ${result.price.toFixed(0)}`,
    `Aerolínea: ${result.airlines}`,
    `Escalas: ${stopsText}`,
    ""
  ];

  if (result.url) {
    lines.push(
      `Ver en Google Flights: ${result.url}`
    );
  }

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
  const results =
    await Promise.allSettled(
      searches.map(
        async search => ({
          search,

          deals:
            await searchDeals(search)
        })
      )
    );

  const found = [];
  const searchErrors = [];

  results.forEach(
    (result, index) => {

      const search =
        searches[index];

      if (
        result.status ===
        "rejected"
      ) {
        const message =
          `${search.country}: ${
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
        deals
      } = result.value;

      console.log(
        `✓ ${search.country}: ${deals.length} deals`
      );

      for (
        const item of deals
      ) {
        const offer =
          normalizeDeal(
            item,
            search
          );

        if (offer) {
          found.push(offer);
        }
      }
    }
  );

  if (
    found.length === 0 &&
    searchErrors.length ===
      searches.length
  ) {
    throw new Error(
      "Fallaron todas las búsquedas."
    );
  }

  const today =
    new Date()
      .toISOString()
      .slice(0,10);

  /*
   * Solo publicamos:
   * - ida y vuelta
   * - fecha futura
   * - 7 a 15 días
   * - hasta USD 1000
   * - con link real de Google Flights
   */
  const validOffers =
    found.filter(
      offer =>
        offer.roundTrip === true &&

        offer.departure >= today &&

        offer.returnDate >
          offer.departure &&

        offer.tripDays >= 7 &&

        offer.tripDays <= 15 &&

        offer.price <=
          WEBSITE_MAX_PRICE &&

        Boolean(offer.url)
    );

  /*
   * Evitamos duplicados.
   * Si aparece la misma ruta/fecha
   * más de una vez, guardamos
   * el precio más barato.
   */
  const uniqueMap =
    new Map();

  for (
    const offer of validOffers
  ) {
    const duplicateKey = [
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
      offer.price <
        existing.price
    ) {
      uniqueMap.set(
        duplicateKey,
        offer
      );
    }
  }

  const currentOffers =
    [...uniqueMap.values()]
      .sort(
        (a,b) =>
          a.price-b.price
      )
      .slice(0,200);

  state.offers =
    currentOffers;

  state.lastRun =
    new Date()
      .toISOString();

  state.lastErrors =
    searchErrors;

  /*
   * ALERTAS
   */
  const alertCandidates =
    currentOffers
      .filter(offer => {

        const normalDeal =
          offer.price <=
          EMAIL_MAX_PRICE;

        const directDeal =
          offer.direct &&
          offer.price <=
          DIRECT_EMAIL_MAX_PRICE;

        return (
          normalDeal ||
          directDeal
        );
      })
      .filter(offer => {

        const previous =
          state.alerted[
            offer.key
          ];

        return (
          !previous ||
          offer.price <
            previous.price
        );
      })
      .sort(
        (a,b) =>
          a.price-b.price
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
        `⚠️ No se pudo enviar el correo: ${error.message}`
      );
    }
  }

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
        x.direct
    ).length;

  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "🌍 EUROTRIP GIRLS — DEALS"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Ofertas válidas con link: ${currentOffers.length}`
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

  if (
    currentOffers.length
  ) {
    const cheapest =
      currentOffers[0];

    console.log(
      `💰 Más barata: ${cheapest.route} · USD ${cheapest.price} · ${cheapest.tripDays} días`
    );

    console.log(
      `🔗 Link Google Flights: sí`
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
