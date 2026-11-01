# Airport Reach

**How far is the nearest large airport from the places people live?**
An interactive map that gives every city its nearest large airport with scheduled service and the distance to it, then lets you explore the result: filter to the cities that are far from any hub, click an airport to see who depends on it, click anywhere to find your own distance.

- **Data:** [OurAirports](https://ourairports.com/data/) (public domain) + [GeoNames](https://download.geonames.org/export/dump/) cities of 15,000+ people (CC BY 4.0)
- **Map:** MapLibre GL JS, clustered airports, data-driven circles, great-circle links, 100 km / 250 km rings
- **AWS:** Amazon Location Service (basemap, place search, driving routes), S3 + CloudFront (hosting), Athena + Apache Iceberg (analytics at scale)

## Run it locally in two minutes

```bash
pip install pandas numpy            # pyarrow optional, for Parquet output
python pipeline/build_dataset.py    # full run: downloads OurAirports + GeoNames (use --seed for the bundled sample)
python -m http.server 8080 -d web   # open http://localhost:8080
```

`web/data/` already contains output built from the small bundled sample (`--seed`), so the page works before you run anything. The sample has about 120 airports and 125 cities with **approximate, hand-entered coordinates and populations**. It is for trying the app, not for drawing conclusions. A banner in the UI says so until you replace it with the full build.

Pipeline options: `--types large_airport,medium_airport` (what counts as "large"), `--min-pop 50000`, `--include-unscheduled`, `--airports` / `--cities` (local path or URL).

## What the map does

| Interaction | What happens |
|---|---|
| Colour of each city | Distance to nearest large airport: under 50, 50–100, 100–250, 250–500, 500+ km |
| **Farther than** slider, city size, country | Filters the map, the headline numbers and the "farthest" list together |
| Click a city | Great-circle link to its airport, 100/250 km rings around that airport, route button |
| Click an airport | Every city it is the nearest airport for, linked in a spoke pattern, with people served |
| Click empty map | Drops a pin and measures to the nearest large airport |
| Search | Local cities and IATA codes instantly; with an Amazon Location key, any address or place too |
| Route button | With a key: driving route from Amazon Location Routes. Without: straight-line distance |
| Share | The URL hash (`#a=DEL`, `#c=Yakutsk,RU`, `#p=lat,lon`) restores the selection |

## Deploy to AWS

```bash
export AWS_REGION=us-east-1                 # any Region where Amazon Location Service is available
python pipeline/build_dataset.py
bash aws/deploy.sh                          # needs AWS CLI v2 and credentials
```

`aws/template.yaml` creates a private S3 bucket behind CloudFront (origin access control), and an **Amazon Location API key** limited to the map tile, place search and route actions, on this Region's default providers, and to this site's CloudFront origin as referer. `deploy.sh` reads the key value, writes it into a deployed-only `config.js`, syncs `web/` to S3 and invalidates CloudFront. The key lives in the browser by design; the referer and action restrictions are what protect it.

Without a key the app still works: plain dark canvas with graticule (or OpenStreetMap tiles via the Basemap switch; mind the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)), local search and straight-line distances.

### How the pieces fit

```
OurAirports CSV ─┐                                   ┌─ web/data/*.geojson ─► S3 ─► CloudFront ─► MapLibre app
GeoNames cities ─┴─► pipeline/build_dataset.py ──────┤                                              │
                    (or aws/athena_iceberg.sql)      └─ *.parquet (optional) ─► S3 ─► Athena/Iceberg │
                                                                                                      ▼
                                                              Amazon Location: basemap · SearchText · CalculateRoutes
```

For the full dataset the nearest-airport join is small enough for numpy (a few thousand cities × several hundred airports). `aws/athena_iceberg.sql` does the same analysis inside Athena with `great_circle_distance`, stores it as an Iceberg table, and shows `MERGE` refreshes and time travel, which is the route to take if you scale to larger point sets (for example Overture Maps places from the Registry of Open Data).

## Honest status

Checked in the environment this was written in:
- Pipeline runs end to end on the bundled sample; output schema and numbers inspected.
- Geometry helpers (haversine, destination, great circle, rings, antimeridian handling) unit-tested; browser distances agree with the pipeline's numpy distances.
- The page's logic was run in headless Chrome against a stub of MapLibre: data loading, filters and headline numbers, search, selection of cities / airports / pins, hash restore, and the request shapes sent to Amazon Location (mocked). All checks pass.
- `deploy.sh` passes `bash -n`; the CloudFormation template parses and all references resolve.

**Not** checked, because the sandbox could not reach those hosts. Treat each as a first-run item:
- Real MapLibre rendering and tile loading (layer paint expressions, clustering, label fonts on the Amazon style).
- Live Amazon Location calls. The request/response handling follows the v2 `search-text` and `routes` APIs as I know them; the response fields read are `ResultItems[].Position/Title`, and `Routes[].Legs[].Geometry.LineString` with distance in metres and duration in seconds. Confirm against the API reference if the route summary looks off.
- `aws location describe-key ... --query Key` returning the key value, and the exact `AllowActions` names accepted by `AWS::Location::APIKey`. Run `cfn-lint` and a first deploy.
- The full OurAirports / GeoNames download and the Athena SQL (check the `raw_airports` column order against your CSV header).

## Layout

```
pipeline/build_dataset.py   nearest-airport analysis → GeoJSON, meta.json, optional Parquet
pipeline/seed/              small sample in the same file formats as the real sources
web/                        static app: index.html, app.js, geo.js, style.css, config.js, data/
aws/template.yaml           S3 + CloudFront + restricted Amazon Location API key
aws/deploy.sh               one-command deploy
aws/athena_iceberg.sql      the analysis as Athena SQL + an Iceberg table
SUBMISSION.md               write-up and 3-minute demo script
```

Data attribution: Airports © OurAirports (public domain). Cities © GeoNames (CC BY 4.0).
