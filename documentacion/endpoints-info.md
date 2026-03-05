# Endpoints API `info`

Documentacion de los endpoints para consultar registros en `info`.

Base URL local:

```text
http://localhost:1337/api
```

## 1) Buscar por texto, nombre completo o CUI

Endpoint:

```http
GET /infos/search
```

Query params:

- `q` (requerido): texto de busqueda (nombre, apellido o CUI)
- `limit` (opcional): cantidad por pagina (default `20`, max `100`)
- `page` (opcional): pagina (default `1`)

Ejemplos:

```http
GET /api/infos/search?q=Carlos Hernandez
GET /api/infos/search?q=2808443950101
GET /api/infos/search?q=Rolando&limit=50&page=2
```

Respuesta (ejemplo):

```json
{
  "data": [
    {
      "id": 123,
      "documentId": "abc123",
      "CUI": "2808443950101",
      "PRIMER_NOMBRE": "Carlos",
      "SEGUNDO_NOMBRE": "Eduardo",
      "TERCER_NOMBRE": null,
      "PRIMER_APELLIDO": "Hernández",
      "SEGUNDO_APELLIDO": "Hernández",
      "FECHA_NACIMIENTO": "1995-10-11",
      "CORREO_ELECTRONICO": null,
      "TELEFONO": "30088570",
      "PAIS_RESIDENCIA": "GUATEMALA",
      "DEPTO_RESIDENCIA": "GUATEMALA",
      "MUNIC_RESIDENCIA": "MIXCO",
      "DIRECCION": "18 CALLE 12-62 COLONIA SAN JOSE LAS ROSAS",
      "WS_MIDES": "-",
      "WS_MAGA": "-",
      "WS_MSPAS": "-",
      "WS_MINECO": "-",
      "relevance": 0.91
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "count": 1
    },
    "query": "carlos hernandez"
  }
}
```

Error comun:

- Si no envias `q`, responde `400`.

## 2) Listar registros (Strapi core)

Endpoint:

```http
GET /infos
```

Puedes usar filtros nativos, por ejemplo:

```http
GET /api/infos?pagination[page]=1&pagination[pageSize]=20
GET /api/infos?filters[CUI][$eq]=2808443950101
```

## 3) Obtener un registro por ID (core)

Endpoint:

```http
GET /infos/:id
```

Ejemplo:

```http
GET /api/infos/123
```

## Logging de consultas

Las consultas `GET` sobre `info` registran log automatico en `info-log` (usuario, filtros, hora, ruta y metodo).

## Recomendaciones de uso

- Para busqueda de personas, usa `GET /infos/search`.
- Para consultas exactas por CUI, manda solo el numero en `q`.
- Ajusta `limit` segun tu frontend para no cargar respuestas grandes.
