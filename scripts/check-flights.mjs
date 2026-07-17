import fs from "node:fs/promises";
import nodemailer from "nodemailer";

const STATE_FILE = new URL("../public/results.json", import.meta.url);
const EMAIL_MAX_PRICE = 800;
const WEBSITE_MAX_PRICE = 1000;
const durations = [
  { value: "1", label: "Fin de semana" },
  { value: "2", label: "Una semana" },
  { value: "3", label: "Dos semanas" }
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta el secreto ${name}`);
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
  const response = await fetch(`https://serpapi.com/search.json?${query}`);
  if (!response.ok) throw new Error(`SerpApi respondió ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.destinations || [];
}

function summarize(item, duration) {
  const airport = item.destination_airport || {};
  const destination = airport.code || item.name;
  return {
    key: `EZE-${destination}-${item.start_date}-${item.end_date}`,
    origin: "EZE",
    destination,
    destinationName: item.name || destination,
    country: item.country || "Europa",
    route: `EZE → ${destination}`,
    departure: item.start_date,
    returnDate: item.end_date,
    price: Number(item.flight_price),
    airlines: item.airline || "consultar",
    stops: Number.isFinite(Number(item.number_of_stops)) ? Number(item.number_of_stops) : 0,
    season: `Fechas flexibles · ${duration.label}`,
    foundAt: new Date().toISOString(),
    url: item.link || "https://www.google.com/travel/explore?hl=es&curr=USD"
  };
}

function mergeOffers(previous, incoming) {
  const byKey = new Map((previous || []).map(item => [item.key, item]));
  for (const item of incoming) {
    const old = byKey.get(item.key);
    if (!old || item.price <= old.price) byKey.set(item.key, item);
  }
  return [...byKey.values()].filter(x => x.price <= WEBSITE_MAX_PRICE)
    .sort((a, b) => a.price - b.price).slice(0, 100);
}

async function sendEmail(result) {
  const user = required("EMAIL_USER");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user, pass: required("EMAIL_APP_PASSWORD") }
  });
  await transporter.sendMail({
    from: `Eurotrip <${user}>`, to: required("EMAIL_TO"),
    subject: `Oferta a ${result.destinationName} por USD ${result.price.toFixed(0)}`,
    text: [`✈️ ¡Apareció un vuelo dentro de tu presupuesto!`, result.route,
      `Destino: ${result.destinationName}, ${result.country}`,
      `Fechas: ${result.departure} al ${result.returnDate}`,
      `Precio ida y vuelta: USD ${result.price.toFixed(2)}`,
      `Aerolínea: ${result.airlines}`, `Verificar: ${result.url}`].join("\n")
  });
}

const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
const duration = durations[(state.durationCursor || 0) % durations.length];
try {
  const destinations = await searchEurope(duration);
  const found = destinations.filter(x => Number.isFinite(Number(x.flight_price)) && x.start_date && x.end_date)
    .map(x => summarize(x, duration));
  state.offers = mergeOffers(state.offers, found);
  state.durationCursor = ((state.durationCursor || 0) + 1) % durations.length;
  state.lastRun = new Date().toISOString();
  state.lastErrors = [];
  const newest = found.filter(x => x.price <= EMAIL_MAX_PRICE && (!state.alerted?.[x.key] || x.price < state.alerted[x.key].price))
    .sort((a, b) => a.price - b.price)[0];
  if (newest) {
    await sendEmail(newest);
    state.alerted ||= {};
    state.alerted[newest.key] = { price: newest.price, sentAt: new Date().toISOString() };
  }
  console.log(`Europa, ${duration.label}: ${found.length} ofertas; correo: ${newest ? "sí" : "no"}.`);
} catch (error) {
  state.lastRun = new Date().toISOString();
  state.lastErrors = [error.message];
  throw error;
} finally {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}
