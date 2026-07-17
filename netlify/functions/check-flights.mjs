import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

const flexibleSearch = { name: "Cualquier fecha disponible" };
const europeanCountries = new Set([
  "Albania", "Austria", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Czech Republic",
  "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Iceland", "Ireland", "Italy", "Kosovo",
  "Latvia", "Lithuania", "Luxembourg", "Malta", "Moldova", "Montenegro", "Netherlands", "North Macedonia", "Norway",
  "Poland", "Portugal", "Romania", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Turkey",
  "Türkiye", "United Kingdom",
  "Albania", "Alemania", "Austria", "Bélgica", "Bosnia y Herzegovina", "Bulgaria", "Chipre", "Croacia", "Dinamarca",
  "Eslovaquia", "Eslovenia", "España", "Estonia", "Finlandia", "Francia", "Grecia", "Hungría", "Irlanda", "Islandia",
  "Italia", "Kosovo", "Letonia", "Lituania", "Luxemburgo", "Macedonia del Norte", "Malta", "Moldavia", "Montenegro",
  "Noruega", "Países Bajos", "Polonia", "Portugal", "Reino Unido", "República Checa", "Rumania", "Serbia", "Suecia",
  "Suiza", "Turquía"
]);
const EMAIL_MAX_PRICE = 800;
const WEBSITE_MAX_PRICE = 1000;

function required(name) {
  const value = Netlify.env.get(name);
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

async function searchDeals() {
  const query = new URLSearchParams({
    engine: "google_flights_deals",
    departure_id: "EZE",
    type: "1",
    travel_class: "1",
    adults: "1",
    currency: "USD",
    max_price: String(WEBSITE_MAX_PRICE),
    stops: "3",
    hl: "es",
    gl: "ar",
    api_key: required("SERPAPI_KEY")
  });
  const response = await fetch(`https://serpapi.com/search.json?${query}`);
  if (!response.ok) throw new Error(`SerpApi respondió ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return (data.deals || []).filter(deal => europeanCountries.has(deal.country));
}

function summarize(deal) {
  const destination = deal.arrival_airport_code || deal.name;
  return {
    key: `EZE-${destination}-${deal.start_date}-${deal.end_date}`,
    origin: "EZE",
    destination,
    destinationName: deal.name || destination,
    country: deal.country || "Europa",
    route: `EZE → ${destination}`,
    departure: deal.start_date,
    returnDate: deal.end_date,
    price: Number(deal.price),
    averagePrice: Number(deal.average_price) || null,
    discount: Number(deal.discount_percentage) || null,
    airlines: deal.airline || "consultar",
    stops: Number.isFinite(Number(deal.stops)) ? Number(deal.stops) : 0,
    season: flexibleSearch.name,
    foundAt: new Date().toISOString(),
    url: deal.flight_link || "https://www.google.com/travel/flights?hl=es&curr=USD"
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
    `Destino: ${result.destinationName}, ${result.country}`,
    `Fechas: ${result.departure} al ${result.returnDate}`,
    `Precio: USD ${result.price.toFixed(2)}`,
    `Aerolínea: ${result.airlines}`,
    `Escalas: ${result.stops}`,
    `Ver en Google Flights: ${result.url}`,
    "El precio puede cambiar; verificá la oferta antes de comprar."
  ].join("\n");
  await transporter.sendMail({
    from: `Eurotrip <${user}>`, to: required("EMAIL_TO"),
    subject: `Oferta a ${result.destinationName} por USD ${result.price.toFixed(0)}`, text
  });
}

function mergeOffers(previous, incoming) {
  const byKey = new Map((previous || []).map(item => [item.key, item]));
  for (const item of incoming) {
    const old = byKey.get(item.key);
    if (!old || item.price <= old.price) byKey.set(item.key, item);
  }
  return [...byKey.values()]
    .filter(item => Number(item.price) <= WEBSITE_MAX_PRICE)
    .sort((a, b) => a.price - b.price || b.foundAt.localeCompare(a.foundAt))
    .slice(0, 100);
}

export default async () => {
  const store = getStore("eurotrip-state");
  const state = await store.get("state", { type: "json" }) || { alerted: {}, offers: [] };
  const settled = await Promise.allSettled([searchDeals().then(deals => deals
    .filter(deal => Number.isFinite(Number(deal.price)) && deal.start_date && deal.end_date)
    .map(deal => summarize(deal))
  )]);
  const found = settled.flatMap(result => result.status === "fulfilled" ? result.value : []);
  state.offers = mergeOffers(state.offers, found);
  state.lastRun = new Date().toISOString();
  state.lastErrors = settled.filter(x => x.status === "rejected").map(x => String(x.reason?.message || x.reason)).slice(0, 10);

  const newest = found
    .filter(item => item.price <= EMAIL_MAX_PRICE && (!state.alerted[item.key] || item.price < state.alerted[item.key].price))
    .sort((a, b) => a.price - b.price)[0];
  let alerts = 0;
  if (newest) {
    await sendEmail(newest);
    state.alerted[newest.key] = { price: newest.price, sentAt: new Date().toISOString() };
    alerts = 1;
  }

  await store.setJSON("state", state);
  console.log(`Eurotrip Deals: cualquier fecha y duración, todas las aerolíneas, ${found.length} ofertas europeas, ${alerts} alerta, ${state.lastErrors.length} errores.`);
};
