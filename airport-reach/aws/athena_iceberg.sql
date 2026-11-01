-- Airport Reach on Athena + Apache Iceberg
-- Same analysis as pipeline/build_dataset.py, but run where the data lives, and stored as an Iceberg table
-- so it can be refreshed with MERGE and queried as of an earlier point in time.
--
-- Before you start (replace YOUR_BUCKET everywhere):
--   aws s3 cp airports.csv  s3://YOUR_BUCKET/raw/airports/airports.csv      # OurAirports
--   unzip cities15000.zip && aws s3 cp cities15000.txt s3://YOUR_BUCKET/raw/cities/cities15000.txt   # GeoNames
-- Run the statements one at a time in the Athena console (engine version 3).
-- Column order in raw_airports must match the header of the airports.csv you downloaded: check with `head -1 airports.csv`.

CREATE DATABASE IF NOT EXISTS airport_reach;

-- 1) Raw files as external tables ------------------------------------------------------------------
CREATE EXTERNAL TABLE IF NOT EXISTS airport_reach.raw_airports (
  id string, ident string, type string, name string, latitude_deg string, longitude_deg string,
  elevation_ft string, continent string, iso_country string, iso_region string, municipality string,
  scheduled_service string, icao_code string, iata_code string, gps_code string, local_code string,
  home_link string, wikipedia_link string, keywords string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.OpenCSVSerde'
WITH SERDEPROPERTIES ('separatorChar' = ',', 'quoteChar' = '"', 'escapeChar' = '\\')
LOCATION 's3://YOUR_BUCKET/raw/airports/'
TBLPROPERTIES ('skip.header.line.count' = '1');

CREATE EXTERNAL TABLE IF NOT EXISTS airport_reach.raw_cities (
  geonameid string, name string, asciiname string, alternatenames string, latitude string, longitude string,
  feature_class string, feature_code string, country_code string, cc2 string, admin1 string, admin2 string,
  admin3 string, admin4 string, population string, elevation string, dem string, timezone string, modified string
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
LOCATION 's3://YOUR_BUCKET/raw/cities/';

-- 2) Nearest large airport per city, written as an Iceberg table -----------------------------------
CREATE TABLE airport_reach.city_access
WITH (
  table_type = 'ICEBERG',
  format = 'PARQUET',
  is_external = false,
  location = 's3://YOUR_BUCKET/iceberg/city_access/'
) AS
WITH apt AS (
  SELECT iata_code, name AS airport_name,
         CAST(latitude_deg AS double) AS lat, CAST(longitude_deg AS double) AS lon
  FROM airport_reach.raw_airports
  WHERE type = 'large_airport' AND scheduled_service = 'yes' AND iata_code <> ''
),
cty AS (
  SELECT CAST(geonameid AS bigint) AS city_id, name, country_code,
         CAST(latitude AS double) AS lat, CAST(longitude AS double) AS lon,
         CAST(population AS bigint) AS population
  FROM airport_reach.raw_cities
  WHERE feature_class = 'P' AND CAST(population AS bigint) >= 100000
),
ranked AS (
  SELECT c.city_id, c.name, c.country_code, c.lat, c.lon, c.population,
         a.iata_code AS nearest_iata, a.airport_name,
         great_circle_distance(c.lat, c.lon, a.lat, a.lon) AS dist_km,   -- kilometres
         row_number() OVER (
           PARTITION BY c.city_id
           ORDER BY great_circle_distance(c.lat, c.lon, a.lat, a.lon)
         ) AS rn
  FROM cty c CROSS JOIN apt a
)
SELECT city_id, name, country_code, lat, lon, population, nearest_iata, airport_name, round(dist_km, 1) AS dist_km
FROM ranked
WHERE rn = 1;

-- 3) Questions worth asking --------------------------------------------------------------------------
-- Headline: share of listed city population living 250 km or more from a large airport
SELECT round(100.0 * sum(CASE WHEN dist_km >= 250 THEN population ELSE 0 END) / sum(population), 2) AS pct_pop_250km_plus,
       approx_percentile(dist_km, 0.5) AS median_km,
       count(*) AS cities
FROM airport_reach.city_access;

-- Which countries have the most people far from a hub?
SELECT country_code, sum(population) AS people_250km_plus, count(*) AS cities
FROM airport_reach.city_access
WHERE dist_km >= 250
GROUP BY country_code
ORDER BY people_250km_plus DESC
LIMIT 15;

-- The busiest catchments: airports ranked by the population that has them as nearest
SELECT nearest_iata, max(airport_name) AS airport, count(*) AS cities, sum(population) AS people
FROM airport_reach.city_access
GROUP BY nearest_iata
ORDER BY people DESC
LIMIT 15;

-- 4) Why Iceberg: refresh in place, and look back in time --------------------------------------------
-- Re-run the CTAS SELECT into a staging table (city_access_new), then:
-- MERGE INTO airport_reach.city_access t
-- USING airport_reach.city_access_new s ON t.city_id = s.city_id
-- WHEN MATCHED THEN UPDATE SET nearest_iata = s.nearest_iata, airport_name = s.airport_name, dist_km = s.dist_km, population = s.population
-- WHEN NOT MATCHED THEN INSERT VALUES (s.city_id, s.name, s.country_code, s.lat, s.lon, s.population, s.nearest_iata, s.airport_name, s.dist_km);

-- What did the table say before the refresh?
-- SELECT count(*) FROM airport_reach.city_access FOR TIMESTAMP AS OF (current_timestamp - interval '1' day);

-- 5) Cross-check: these numbers should match web/data/meta.json produced by the Python pipeline
--    when both use the same filters (large_airport, scheduled service, population >= 100000).
