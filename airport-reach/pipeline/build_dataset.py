#!/usr/bin/env python3
"""Airport Reach: build the map dataset.

For every city, find the nearest large airport with scheduled service and the
great-circle distance to it. Writes GeoJSON for the web app, a small meta.json
with headline statistics, and (if pyarrow is installed) Parquet copies that can
be loaded straight into S3 / Athena / Iceberg.

Inputs (local path or http(s) URL):
  --airports  OurAirports airports.csv   (public domain)
  --cities    GeoNames cities15000.zip   (CC BY 4.0), or a CSV with the columns
              name,country_code,latitude,longitude,population

Examples:
  python build_dataset.py --seed                  # bundled sample, works offline
  python build_dataset.py                         # full run, downloads both sources
  python build_dataset.py --types large_airport,medium_airport --min-pop 50000
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
EARTH_KM = 6371.0088
BAND_EDGES = [50, 100, 250, 500]  # km; band index = number of edges the distance meets or exceeds

GEONAMES_COLS = [
    "geonameid", "name", "asciiname", "alternatenames", "latitude", "longitude",
    "feature_class", "feature_code", "country_code", "cc2", "admin1", "admin2",
    "admin3", "admin4", "population", "elevation", "dem", "timezone", "modified",
]


def open_source(src: str) -> io.BytesIO | str:
    """Return a path, or an in-memory buffer when src is a URL."""
    if src.lower().startswith(("http://", "https://")):
        req = urllib.request.Request(src, headers={"User-Agent": "airport-reach/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            return io.BytesIO(resp.read())
    return src


def load_airports(src: str, types: list[str], scheduled_only: bool) -> pd.DataFrame:
    # keep_default_na=False matters: Namibia's ISO code is "NA" and would become NaN.
    df = pd.read_csv(open_source(src), dtype=str, keep_default_na=False)
    need = {"ident", "type", "name", "latitude_deg", "longitude_deg", "iso_country",
            "municipality", "scheduled_service", "iata_code"}
    missing = need - set(df.columns)
    if missing:
        sys.exit(f"airports file is missing columns: {sorted(missing)}")
    df = df[df["type"].isin(types)]
    if scheduled_only:
        df = df[df["scheduled_service"].str.lower() == "yes"]
    df = df[df["iata_code"].str.strip() != ""].copy()
    df["lat"] = pd.to_numeric(df["latitude_deg"], errors="coerce")
    df["lon"] = pd.to_numeric(df["longitude_deg"], errors="coerce")
    df = df.dropna(subset=["lat", "lon"]).drop_duplicates("iata_code").reset_index(drop=True)
    return df


def load_cities(src: str, min_pop: int) -> pd.DataFrame:
    lower = src.lower().split("?")[0]
    if lower.endswith((".zip", ".txt", ".tsv")):
        df = pd.read_csv(
            open_source(src), sep="\t", header=None, names=GEONAMES_COLS,
            dtype=str, keep_default_na=False, quoting=csv.QUOTE_NONE,
            compression="zip" if lower.endswith(".zip") else None,
            usecols=["name", "latitude", "longitude", "feature_class", "country_code", "population"],
        )
        df = df[df["feature_class"] == "P"]
    else:
        df = pd.read_csv(open_source(src), dtype=str, keep_default_na=False)
        need = {"name", "country_code", "latitude", "longitude", "population"}
        missing = need - set(df.columns)
        if missing:
            sys.exit(f"cities file is missing columns: {sorted(missing)}")
    df = df.copy()
    df["lat"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["lon"] = pd.to_numeric(df["longitude"], errors="coerce")
    df["pop"] = pd.to_numeric(df["population"], errors="coerce").fillna(0).astype(np.int64)
    df = df.dropna(subset=["lat", "lon"])
    df = df[df["pop"] >= min_pop].reset_index(drop=True)
    return df


def nearest(c_lat, c_lon, a_lat, a_lon, chunk: int = 2000):
    """Vectorised haversine nearest-neighbour. Inputs in degrees, output in km."""
    cl, co = np.radians(c_lat), np.radians(c_lon)
    al, ao = np.radians(a_lat), np.radians(a_lon)
    idx = np.empty(len(cl), dtype=np.int64)
    dist = np.empty(len(cl), dtype=np.float64)
    for s in range(0, len(cl), chunk):
        e = s + chunk
        dlat = al[None, :] - cl[s:e, None]
        dlon = ao[None, :] - co[s:e, None]
        h = np.sin(dlat / 2) ** 2 + np.cos(cl[s:e, None]) * np.cos(al[None, :]) * np.sin(dlon / 2) ** 2
        d = 2 * EARTH_KM * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
        j = d.argmin(axis=1)
        idx[s:e] = j
        dist[s:e] = d[np.arange(len(j)), j]
    return idx, dist


def feature(lon, lat, props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(float(lon), 4), round(float(lat), 4)]},
            "properties": props}


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", action="store_true", help="use the bundled sample files in pipeline/seed (offline)")
    ap.add_argument("--airports", default=AIRPORTS_URL)
    ap.add_argument("--cities", default=CITIES_URL)
    ap.add_argument("--out", default=str(here.parent / "web" / "data"))
    ap.add_argument("--types", default="large_airport", help="comma-separated OurAirports types to count as 'large'")
    ap.add_argument("--include-unscheduled", action="store_true", help="do not require scheduled_service == yes")
    ap.add_argument("--min-pop", type=int, default=100_000)
    a = ap.parse_args()

    if a.seed:
        a.airports = str(here / "seed" / "airports_seed.csv")
        a.cities = str(here / "seed" / "cities_seed.csv")
    label = "seed" if a.seed else "full"

    airports = load_airports(a.airports, [t.strip() for t in a.types.split(",")], not a.include_unscheduled)
    cities = load_cities(a.cities, a.min_pop)
    if airports.empty or cities.empty:
        sys.exit("no airports or no cities left after filtering; check inputs and --types/--min-pop")

    idx, dist = nearest(cities["lat"].to_numpy(), cities["lon"].to_numpy(),
                        airports["lat"].to_numpy(), airports["lon"].to_numpy())
    cities["nearest"] = airports["iata_code"].to_numpy()[idx]
    cities["dist_km"] = np.round(dist, 1)
    cities["band"] = np.searchsorted(BAND_EDGES, cities["dist_km"].to_numpy(), side="right")

    served = cities.groupby("nearest").agg(served_cities=("name", "size"), served_pop=("pop", "sum"))
    airports = airports.join(served, on="iata_code")
    airports[["served_cities", "served_pop"]] = airports[["served_cities", "served_pop"]].fillna(0).astype(np.int64)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    city_fc = {"type": "FeatureCollection", "features": [
        feature(r.lon, r.lat, {"name": r.name, "cc": r.country_code, "pop": int(r.pop),
                               "nearest": r.nearest, "dist_km": float(r.dist_km), "band": int(r.band)})
        for r in cities.itertuples()]}
    airport_fc = {"type": "FeatureCollection", "features": [
        feature(r.lon, r.lat, {"iata": r.iata_code, "icao": r.ident, "name": r.name, "city": r.municipality,
                               "cc": r.iso_country, "type": r.type,
                               "served_cities": int(r.served_cities), "served_pop": int(r.served_pop)})
        for r in airports.itertuples()]}
    (out / "cities.geojson").write_text(json.dumps(city_fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (out / "airports.geojson").write_text(json.dumps(airport_fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    total_pop = int(cities["pop"].sum())
    beyond = {}
    for km in (50, 100, 250, 500):
        m = cities["dist_km"] >= km
        beyond[str(km)] = {"cities": int(m.sum()),
                           "pop": int(cities.loc[m, "pop"].sum()),
                           "pop_share": round(float(cities.loc[m, "pop"].sum()) / total_pop, 4) if total_pop else 0.0}
    by_country = (cities[cities["dist_km"] >= 250].groupby("cc" if "cc" in cities else "country_code")["pop"]
                  .sum().sort_values(ascending=False).head(10))
    meta = {
        "label": label,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {"airports": a.airports, "cities": a.cities},
        "attribution": "Airports: OurAirports (public domain). Cities: GeoNames (CC BY 4.0).",
        "filters": {"airport_types": a.types, "scheduled_only": not a.include_unscheduled, "min_city_pop": a.min_pop},
        "counts": {"cities": int(len(cities)), "airports": int(len(airports)), "population": total_pop},
        "bands_km": BAND_EDGES,
        "beyond": beyond,
        "median_dist_km": float(np.round(np.median(cities["dist_km"]), 1)),
        "pop_beyond_250km_by_country": {k: int(v) for k, v in by_country.items()},
        "farthest": [{"name": r.name, "cc": r.country_code, "dist_km": float(r.dist_km), "nearest": r.nearest, "pop": int(r.pop)}
                     for r in cities.sort_values("dist_km", ascending=False).head(10).itertuples()],
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    try:  # optional: columnar copies for S3 / Athena / Iceberg
        cities.drop(columns=[c for c in ("latitude", "longitude", "population", "feature_class") if c in cities]) \
              .to_parquet(out / "cities.parquet", index=False)
        airports.drop(columns=["latitude_deg", "longitude_deg"]).to_parquet(out / "airports.parquet", index=False)
        parquet = True
    except ImportError:
        parquet = False

    print(f"[{label}] {len(cities)} cities x {len(airports)} airports -> {out}")
    print(f"  median distance to nearest airport: {meta['median_dist_km']} km")
    print(f"  population >= 250 km away: {beyond['250']['pop']:,} ({beyond['250']['pop_share']:.1%})")
    print("  parquet:", "written" if parquet else "skipped (pip install pyarrow)")


if __name__ == "__main__":
    main()
