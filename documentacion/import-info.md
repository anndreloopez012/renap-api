# Importador masivo de `info`

Este proyecto incluye un importador por **streaming** para cargar archivos CSV grandes al content-type `api::info.info`.

Archivo del script: `scripts/import-info.js`

## Requisitos

- Node.js (segun el proyecto)
- Proyecto con dependencias instaladas (`npm install`)
- Base de datos configurada en `.env` para importacion real

## Formato del archivo

- Delimitador de columnas: `;`
- Separador de filas: salto de linea (enter)
- Primera fila: encabezados
- Los encabezados deben coincidir con los campos del type `info`

Ejemplo de encabezado:

```csv
CUI;PRIMER_NOMBRE;SEGUNDO_NOMBRE;TERCER_NOMBRE;PRIMER_APELLIDO;SEGUNDO_APELLIDO;FECHA_NACIMIENTO;CORREO_ELECTRONICO;TELEFONO;PAIS_RESIDENCIA;DEPTO_RESIDENCIA;MUNIC_RESIDENCIA;DIRECCION;WS_MIDES;WS_MAGA;WS_MSPAS;WS_MINECO
```

## Formato de fechas

Campo `FECHA_NACIMIENTO` soporta:

- `dd/mm/yyyy` (ej. `11/10/1995`)
- `dd/mm/yyyy hh:mm:ss` (ej. `11/10/1995 00:00:02`)
- `yyyy-mm-dd` (ej. `1995-10-11`)

## Comandos

### 1) Validar archivo sin insertar en DB (recomendado)

```bash
npm run import:info -- --file /ruta/archivo.csv --dry-run
```

### 2) Importacion real

```bash
npm run import:info -- --file /ruta/archivo.csv --batch-size 5000
```

### 3) Importacion real para CSV de Excel (tildes/ñ)

```bash
npm run import:info -- --file /ruta/archivo.csv --batch-size 5000 --encoding latin1
```

## Parametros

- `--file` o `-f`: ruta del archivo (obligatorio)
- `--delimiter` o `-d`: delimitador (default `;`)
- `--batch-size` o `-b`: tamano de lote para insercion (default `5000`)
- `--encoding` o `-e`: `auto|utf8|latin1` (default `auto`)
- `--dry-run`: valida y parsea, pero no inserta

## Codificacion y caracteres especiales

- Por defecto se usa `--encoding auto`
- El importador detecta automaticamente `utf8` o `latin1` revisando varias zonas del archivo
- Si notas textos como `Mar�a`, reintenta con `--encoding latin1`
- Si tu archivo esta en UTF-8, usa `--encoding utf8`
- Si durante la carga aparece el caracter `�`, el importador detiene el proceso para evitar guardar datos dañados

## Flujo recomendado

1. Validar primero (sin insertar):

```bash
npm run import:info -- --file "/ruta/archivo.csv" --dry-run --batch-size 5000 --encoding auto
```

2. Si en validacion ves `�` o tildes dañadas, correr con `latin1`:

```bash
npm run import:info -- --file "/ruta/archivo.csv" --dry-run --batch-size 5000 --encoding latin1
```

3. Cuando el `dry-run` salga bien, ejecutar importacion real:

```bash
npm run import:info -- --file "/ruta/archivo.csv" --batch-size 5000 --encoding latin1
```

## Recomendaciones para archivos grandes

- Ejecutar primero con `--dry-run`
- Empezar con `--batch-size 5000`
- Si hay alta carga en DB, bajar a `2000` o `1000`
- Ejecutar en una terminal dedicada (no cerrar la sesion)

## Tolerancia a errores

- Si una fila tiene error de formato, se registra y el proceso continua
- Si falla un lote, el importador divide el lote para aislar filas problematicas
- El log de errores se guarda en:

```text
.tmp/import-errors/info-import-<timestamp>.errors.ndjson
```

## Salida esperada

Al finalizar muestra:

- filas procesadas
- filas insertadas
- filas fallidas
- filas vacias omitidas
- ruta del archivo de errores

## Ayuda rapida

```bash
npm run import:info -- --help
```
