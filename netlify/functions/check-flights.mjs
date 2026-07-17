import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

const destinations = ["MAD", "BCN", "LIS", "OPO", "FCO", "MXP", "PAR", "AMS", "FRA", "MUC", "LON", "DUB", "BRU", "ZRH", "VIE", "ATH"];
const seasons = [
  { name: "Otoño europeo 2026", from: "2026-09-01", to: "2026-11-30" },
  { name: "Primavera europea 2027", from: "2027-03-01", to: "2027-05-31" },
  { name: "Verano europeo 2027", from: "2027-06-01", to: "2027-08-31" }
];
const lengths = [10, 14, 17, 21];
const MAX_PRICE = 800;
const SEARCHES_PER_RUN = 6;

function required(name) {
  const value = Netlify.env.get(name);
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

function addDays(text, days) {
  const date = new Date(`${text}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildSearches() {
  const searches = [];
  for (const season of seasons) {
    for (let departure = season.from; departure <= season.to; departure = addDays(departure, 7)) {
      for (const length of lengths) {
        const returnDate = addDays(departure, length);
        if (returnDate > season.to) continue;
        for (const destination of destinations) searches.push({ destination, departure, returnDate, season: season.name });
      }
    }
  }
  return searches;
}

async function search(item) {
  const query = new URLSearchParams({
    engine: "google_flights", departure_id: "EZE", arrival_id: item.destination,
    outbound_date: item.departure, return_date: item.returnDate, type: "1",
    travel_class: "1", adults: "1", currency: "USD", hl: "es", gl: "ar",
    api_key: required("SERPAPI_KEY")
  });
  const response = await fetch(`https://serpapi.com/search.json?${query}`);
  if (!response.ok) throw new Error(`SerpApi respondió ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return [...(data.best_flights || []), ...(data.other_flights || [])];
}

function summarize(offer, item) {
  const flights = offer.flights || [];
  const airlines = [...new Set(flights.map(x => x.airline).filter(Boolean))].join(", ");
  return {
    key: `EZE-${item.destination}-${item.departure}-${item.returnDate}`,
    route: `EZE → ${item.destination}`,
    departure: item.departure,
    returnDate: item.returnDate,
    price: Number(offer.price),
    airlines,
    stops: Math.max(0, flights.length - 1)
  };
}

async function sendEmail(result) {
  const user = required("EMAIL_USER");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user, pass: required("EMAIL_APP_PASSWORD") }
  });
  const text = [
    "✈️ ¡Apareció un vuelo dentro de tu presupuesto!", result.route,
    `Fechas: ${result.departure} al ${result.returnDate}`,
    `Precio: USD ${result.price.toFixed(2)}`,
    `Aerolínea(s): ${result.airlines || "consultar"}`,
    `Escalas del itinerario mostrado: ${result.stops}`,
    "El precio puede cambiar; verificá la oferta antes de comprar."
  ].join("\n");
  await transporter.sendMail({
    from: `Eurotrip <${user}>`, to: required("EMAIL_TO"),
    subject: `Vuelo por USD ${result.price.toFixed(2)}: ${result.route}`, text
  });
}

export default async () => {
  const store = getStore("eurotrip-state");
  const state = await store.get("state", { type: "json" }) || { cursor: 0, alerted: {} };
  const searches = buildSearches();
  const batch = Array.from({ length: SEARCHES_PER_RUN }, (_, offset) => searches[(state.cursor + offset) % searches.length]);
  const settled = await Promise.allSettled(batch.map(async item => {
    const offers = await search(item);
    const eligible = offers.filter(x => Number.isFinite(Number(x.price)) && Number(x.price) <= MAX_PRICE);
    if (!eligible.length) return { checked: true, alert: false };
    const result = summarize(eligible.sort((a, b) => Number(a.price) - Number(b.price))[0], item);
    const previous = state.alerted[result.key];
    if (!previous || result.price < previous.price) {
      await sendEmail(result);
      state.alerted[result.key] = { price: result.price, sentAt: new Date().toISOString() };
      return { checked: true, alert: true };
    }
    return { checked: true, alert: false };
  }));
  state.cursor = (state.cursor + SEARCHES_PER_RUN) % searches.length;
  state.lastRun = new Date().toISOString();
  state.lastErrors = settled.filter(x => x.status === "rejected").map(x => String(x.reason?.message || x.reason)).slice(0, 10);
  await store.setJSON("state", state);
  const alerts = settled.filter(x => x.status === "fulfilled" && x.value.alert).length;
  console.log(`Eurotrip: ${settled.length} búsquedas, ${alerts} alertas, ${state.lastErrors.length} errores.`);
};
