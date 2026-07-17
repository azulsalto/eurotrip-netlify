# Eurotrip para Netlify

Ejecución diaria automática a las 12:00 UTC (09:00 de Argentina). Realiza seis búsquedas, guarda el progreso en Netlify Blobs y envía por Gmail las tarifas de hasta USD 800.

## Variables secretas

Configurar en Netlify, nunca dentro del repositorio:

- `SERPAPI_KEY`
- `EMAIL_USER`
- `EMAIL_APP_PASSWORD`
- `EMAIL_TO`

## Publicación

1. Subir esta carpeta a un repositorio privado de GitHub sin archivo `.env`.
2. En Netlify, elegir **Add new project → Import an existing project**.
3. Conectar el repositorio y publicar con los valores predeterminados.
4. En **Project configuration → Environment variables**, cargar las cuatro variables.
5. Volver a desplegar el proyecto.
6. En **Functions**, abrir `check-flights` y usar **Run now** para la primera prueba.

La función programada aparecerá con la etiqueta **Scheduled**. Los resultados se consultan en los logs de la función.
