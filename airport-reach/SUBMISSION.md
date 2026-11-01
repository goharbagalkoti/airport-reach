# Submission: Airport Reach

Fill the **[brackets]** after you run the full pipeline and deploy. Everything else is ready to paste.

## Title
Airport Reach: how far is the nearest large airport?

## One-line summary
Every GeoNames city with 100,000+ people, joined to its nearest large airport, on a map you can filter, click and measure from.

## The dataset and what is in it
- **OurAirports** `airports.csv`: [N] airports worldwide with type, scheduled-service flag, IATA/ICAO codes and coordinates. Public domain. I keep `large_airport` with scheduled service: [N] airports.
- **GeoNames** `cities15000`: populated places with 15,000+ people, with country and population. CC BY 4.0. I keep cities of 100,000+: [N] cities, [N] million people.
- Both are public, contain no personal data, and are fine to reuse.

## How I put it on the map
1. `pipeline/build_dataset.py` computes the great-circle distance from every city to every candidate airport and keeps the nearest, plus a catchment per airport (cities served, people served).
2. The app draws cities as circles coloured by distance band and sized by population; airports are clustered at world scale and break apart as you zoom.
3. Selecting a city draws a great-circle link to its airport with 100 km and 250 km rings; selecting an airport draws a spoke to every city it serves; clicking empty map drops a pin and measures from it.
4. Amazon Location Service supplies the basemap, address search (any place name or street address becomes a pin with a distance to the nearest hub) and driving routes to the airport.

## AWS services and why
- **Amazon Location Service**: Maps (tiles and style, so the data sits on a real basemap), Places `SearchText` (geocoding turns the dataset into a tool for *your* address), Routes `CalculateRoutes` (straight-line distance says "300 km"; the route says "five hours by road").
- **Amazon S3 + CloudFront**: private bucket with origin access control serving the static app worldwide over HTTPS.
- **Athena + Apache Iceberg on S3**: the same analysis in SQL (`great_circle_distance`), stored as an Iceberg table so it refreshes with `MERGE` and can be queried as of an earlier date. [If you ran it: result of the cross-check query.]
- **CloudFormation**: one template creates the site and a *restricted* Amazon Location API key (only the three APIs used, only this site's origin).

## What the map reveals
[Fill from `web/data/meta.json` after the full run, for example:]
- [X]% of people in cities of 100k+ live 250 km or more from a large airport; the median city is [Y] km from one.
- Farthest large cities: [name, km], [name, km], [name, km].
- [Country] has the most people beyond 250 km: [N] million.
- One catchment that surprised me: [airport] is the nearest hub for [N] cities and [N] million people.

## Links
- Live map: [CloudFront URL]
- Code: [GitHub URL]
- Demo video (under 3 minutes): [YouTube URL]

## Demo script (2:45)
| Time | Show | Say |
|---|---|---|
| 0:00 | World view, cities glowing green to red | "Every dot is a city of 100,000 people or more. Colour is how far it is from the nearest large airport. Green: under 50 km. Red: over 500." |
| 0:15 | Slide **Farther than** to 500 km | "Slide this and the map answers one question: who is far from a hub? [N] cities, [N] million people." |
| 0:35 | Click the top city in **Farthest** list | "The dashed line is the great-circle link; the rings are 100 and 250 km around its nearest airport. [City] is [N] km from [IATA]." |
| 0:55 | **Route to airport** | "Amazon Location Routes turns the straight line into a drive: [N] km, about [N] hours." |
| 1:15 | Click a big hub, e.g. DEL or SIN | "Click an airport and you see who depends on it: [N] cities, [N] million people." |
| 1:40 | Zoom out to show clusters, then zoom in | "Airports are clustered at world scale and separate as you zoom." |
| 1:55 | Type your own address in search | "Amazon Location geocodes any address, and the app measures from it. Mine is [N] km from [IATA]." |
| 2:15 | Open the Athena console / SQL file | "Same analysis in Athena over S3, stored as an Iceberg table, so it can be refreshed with MERGE and queried back in time." |
| 2:35 | Browser address bar | "Hosted on S3 and CloudFront, the key is restricted to this site. Code is on GitHub." |

## Criteria checklist
- **Technical innovation:** analysis + map in one loop (geocode anything, get its distance to the nearest hub); Athena/Iceberg path for scale.
- **Craft:** clustering, expression-driven styling, shareable URL state, keyboard and mobile layout, graceful fallback without a key.
- **Usefulness:** a reusable pattern, "nearest facility to every point", for hospitals, ports, clinics, schools; swap the two input files.
- **Storytelling:** one question, one slider, one surprising answer.
