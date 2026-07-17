# Eurotrip Girls para Netlify

Sitio visual y buscador de ofertas desde Buenos Aires hacia Europa. La función programada se ejecuta todos los días a las 12:00 UTC (09:00 de Argentina), consulta Google Flights Deals mediante SerpApi para cualquier fecha y duración, ida y vuelta y todas las aerolíneas. Guarda hasta 100 ofertas y envía por Gmail las tarifas de hasta USD 800.

## Variables secretas

Configurar únicamente en Netlify:

- `SERPAPI_KEY`
- `EMAIL_USER`
- `EMAIL_APP_PASSWORD`
- `EMAIL_TO`

Nunca subir un archivo `.env` ni publicar capturas con las claves.

## Funciones

- `check-flights`: usa Google Flights Deals para cualquier fecha y duración, ida y vuelta y todas las aerolíneas.
- `get-results`: entrega al sitio las ofertas guardadas, sin revelar la clave y sin gastar búsquedas extra.

Después de publicar, ejecutar `check-flights` una vez desde Netlify para cargar los primeros resultados en la página.
