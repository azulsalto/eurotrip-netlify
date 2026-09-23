import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);

// CONFIGURACIÓN
const EMAIL_MAX_PRICE = 800;

// Si es DIRECTO, también nos interesa hasta USD 900
const DIRECT_EMAIL_MAX_PRICE = 900;

// La web muestra vuelos de hasta USD 1000
const WEBSITE_MAX_PRICE = 1000;

// No conservar resultados encontrados hace más de 14 días
const RECENT_DAYS = 14;

// Buscar SIEMPRE 1 y 2 semanas
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

function summarize(item, duration) {

  const airport =
    item.destination_airport || {};

  const destination =
    airport.code || item.name;

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
      Number.isFinite(
        Number(item.number_of_stops)
      )
        ? Number(item.number_of_stops)
        : 0,

    season:
      `Fechas flexibles · ${duration.label}`,

    foundAt:
      new Date().toISOString(),

    url:
      item.link ||
      "https://www.google.com/travel/explore?hl=es&curr=USD"
  };
}


/*
------------------------------------------------
GUARDAR Y LIMPIAR OFERTAS
------------------------------------------------

Ahora:

✓ elimina viajes vencidos
✓ elimina resultados encontrados hace más de 14 días
✓ elimina antiguos "Fin de semana"
✓ detecta bajas de precio
✓ marca resultados encontrados hoy
*/

function mergeOffers(previous, incoming) {

  const now = Date.now();

  const cutoff =
    now -
    RECENT_DAYS *
    24 *
    60 *
    60 *
    1000;

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const byKey =
    new Map();


  /*
  -------------------------
  CONSERVAR OFERTAS RECIENTES
  -------------------------
  */

  for (const item of previous || []) {

    const found =
      Date.parse(
        item.foundAt || 0
      );

    const validDuration =
      item.season?.includes("Una semana") ||
      item.season?.includes("Dos semanas");

    const futureFlight =
      item.returnDate >= today;

    const recent =
      found >= cutoff;

    const validPrice =
      Number(item.price) <=
      WEBSITE_MAX_PRICE;


    if (
      validDuration &&
      futureFlight &&
      recent &&
      validPrice
    ) {

      byKey.set(
        item.key,
        {
          ...item,
          foundToday: false
        }
      );

    }

  }


  /*
  -------------------------
  AGREGAR RESULTADOS DE HOY
  -------------------------
  */

  for (const item of incoming) {

    const old =
      byKey.get(item.key);

    const previousPrice =
      old
        ? Number(old.price)
        : null;


    const priceDrop =
      Number.isFinite(previousPrice) &&
      item.price < previousPrice

        ? previousPrice -
          item.price

        : 0;


    byKey.set(
      item.key,
      {

        ...item,

        previousPrice,

        priceDrop,

        foundToday: true

      }
    );

  }


  return [
    ...byKey.values()
  ]

    .filter(
      x =>
        Number(x.price) <=
        WEBSITE_MAX_PRICE
    )

    .sort(
      (a, b) =>
        a.price - b.price
    )

    .slice(
      0,
      100
    );
}


/*
------------------------------------------------
EMAIL
------------------------------------------------
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


  const direct =
    result.stops === 0;


  const reason =
    direct &&
    result.price >
    EMAIL_MAX_PRICE

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

      `Escalas: ${result.stops}`,

      `Duración: ${result.season}`,

      "",

      result.priceDrop > 0
        ? `📉 Bajó USD ${result.priceDrop.toFixed(0)} desde la última búsqueda`
        : "",

      "",

      `Verificar vuelo: ${result.url}`

    ].join("\n")

  });

}


/*
------------------------------------------------
LEER RESULTADOS ANTERIORES
------------------------------------------------
*/

const state =
  JSON.parse(

    await fs.readFile(
      STATE_FILE,
      "utf8"
    )

  );


try {


  /*
  ------------------------------------------------
  BUSCAR 1 Y 2 SEMANAS TODOS LOS DÍAS
  ------------------------------------------------
  */

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


  /*
  Juntar las dos búsquedas
  */

  const found =
    searches.flat();


  /*
  Guardar resultados limpios
  */

  state.offers =
    mergeOffers(
      state.offers,
      found
    );


  state.lastRun =
    new Date()
      .toISOString();


  state.lastErrors =
    [];


  /*
  ------------------------------------------------
  ALERTAS INTELIGENTES
  ------------------------------------------------

  Mandar mail si:

  1) precio <= USD 800

  O

  2) vuelo DIRECTO <= USD 900

  Y además:

  - nunca fue avisado
  - o bajó de precio
  ------------------------------------------------
  */


  const newest =
    found

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

          &&

          (

            !state.alerted?.[
              x.key
            ]

            ||

            x.price <
            state.alerted[
              x.key
            ].price

          )

      )

      .sort(

        (a, b) =>
          a.price -
          b.price

      )[0];


  /*
  Enviar mail
  */

  if (newest) {

    const savedOffer =
      state.offers.find(
        x =>
          x.key ===
          newest.key
      );

    await sendEmail(
      savedOffer ||
      newest
    );


    state.alerted ||=
      {};


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


  /*
  LOG PARA GITHUB ACTIONS
  */

  const directCount =
    found.filter(
      x =>
        x.stops === 0
    ).length;


  console.log(

    `Europa: ${found.length} ofertas encontradas ` +

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
