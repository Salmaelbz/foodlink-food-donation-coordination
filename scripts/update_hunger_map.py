import csv
import json
import math
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "static" / "data"
DATA_URL = "https://ourworldindata.org/grapher/prevalence-of-undernourishment.csv"
METADATA_URL = "https://ourworldindata.org/grapher/prevalence-of-undernourishment.metadata.json"
GEOMETRY_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
INDICATOR_COLUMN = "2.1.1 prevalence of undernourishment - Value (percent)"
WIDTH, HEIGHT = 1200, 600


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "FoodLink hunger map snapshot"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def load_latest_country_values(csv_content):
    latest = {}
    for row in csv.DictReader(csv_content.decode("utf-8").splitlines()):
        code = row.get("Code", "")
        if len(code) != 3 or not code.isalpha() or not row.get(INDICATOR_COLUMN):
            continue
        try:
            year, value = int(row["Year"]), float(row[INDICATOR_COLUMN])
        except (TypeError, ValueError):
            continue
        previous = latest.get(code)
        if previous is None or year > previous["year"]:
            latest[code] = {"iso3": code, "name": row["Entity"], "year": year, "value": value}
    return latest


def simplify(points, tolerance=0.14):
    if len(points) <= 4:
        return points
    first, last = points[0], points[-1]
    dx, dy = last[0] - first[0], last[1] - first[1]
    denominator = dx * dx + dy * dy
    farthest, index = 0, 0
    for candidate in range(1, len(points) - 1):
        if denominator:
            along = ((points[candidate][0] - first[0]) * dx + (points[candidate][1] - first[1]) * dy) / denominator
            projected = (first[0] + along * dx, first[1] + along * dy)
            distance = math.dist(points[candidate], projected)
        else:
            distance = math.dist(points[candidate], first)
        if distance > farthest:
            farthest, index = distance, candidate
    if farthest <= tolerance:
        return [first, last]
    left = simplify(points[: index + 1], tolerance)
    right = simplify(points[index:], tolerance)
    return left[:-1] + right


def project(longitude, latitude):
    x = (longitude + 180) / 360 * WIDTH
    y = (90 - latitude) / 180 * HEIGHT
    return round(x, 1), round(y, 1)


def ring_segments(coordinates):
    points = [project(lon, lat) for lon, lat, *_ in coordinates]
    if len(points) < 4:
        return []
    segments = [[]]
    for previous, current in zip(points, points[1:]):
        if abs(current[0] - previous[0]) > WIDTH / 2:
            if previous[0] < WIDTH / 2:
                edge_x, opposite_x = 0, WIDTH
            else:
                edge_x, opposite_x = WIDTH, 0
            unwrapped_x = current[0] + (WIDTH if current[0] < previous[0] else -WIDTH)
            ratio = (edge_x - previous[0]) / (unwrapped_x - previous[0])
            edge_y = round(previous[1] + ratio * (current[1] - previous[1]), 1)
            segments[-1].append((edge_x, edge_y))
            segments.append([(opposite_x, edge_y)])
        segments[-1].append(current)
    result = []
    for segment in segments:
        if len(segment) < 3:
            continue
        simplified = simplify(segment + [segment[0]])
        result.append("M" + " L".join(f"{x},{y}" for x, y in simplified) + " Z")
    return result


def feature_path(feature):
    geometry = feature.get("geometry")
    if not geometry:
        return ""
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    parts = []
    for polygon in polygons:
        for ring in polygon:
            parts.extend(ring_segments(ring))
    return " ".join(parts)


def build_svg(geojson):
    paths = []
    for feature in geojson["features"]:
        properties = feature["properties"]
        if properties.get("ADMIN") == "Antarctica":
            continue
        iso3 = properties.get("ISO_A3")
        if not iso3 or iso3 == "-99":
            iso3 = properties.get("ADM0_A3", "")
        if len(iso3) != 3 or not iso3.isalpha():
            continue
        path = feature_path(feature)
        if path:
            paths.append(
                f'<path data-iso="{escape(iso3)}" data-name="{escape(properties.get("ADMIN", iso3))}" d="{path}"/>'
            )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
        'preserveAspectRatio="xMidYMid meet" aria-label="World map by country">'
        '<rect class="map-ocean" width="1200" height="600"/>'
        f'<g class="map-countries" fill-rule="evenodd">{"".join(paths)}</g></svg>'
    )


def main():
    csv_content = download(DATA_URL)
    metadata = json.loads(download(METADATA_URL))
    geography = json.loads(download(GEOMETRY_URL))
    latest = load_latest_country_values(csv_content)
    if not latest:
        raise RuntimeError("No country-level hunger observations were found in the source data.")
    selected_column = next(iter(metadata["columns"].values()))
    record = {
        "indicator": "Prevalence of undernourishment (% of population)",
        "definition": selected_column.get("descriptionShort", "").strip(),
        "source": "Food and Agriculture Organization of the United Nations (FAO), distributed by Our World in Data",
        "source_url": "https://ourworldindata.org/grapher/prevalence-of-undernourishment",
        "source_updated": selected_column.get("lastUpdated"),
        "snapshot_date": datetime.now(timezone.utc).date().isoformat(),
        "latest_country_observation_year": max(item["year"] for item in latest.values()),
        "observation_years": sorted({item["year"] for item in latest.values()}),
        "notes": [
            "Each country is shaded using its latest available country-level observation; years differ by country.",
            "FAO reports values below 2.5% as 2.5% because of uncertainty at very low levels.",
            "This indicator is modelled national prevalence of chronic undernourishment, not a real-time acute food insecurity or famine classification.",
            "Countries with no observation are shown in gray; missing values do not mean zero hunger.",
        ],
        "countries": sorted(latest.values(), key=lambda item: item["name"]),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "hunger-prevalence.json").write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA_DIR / "world-countries.svg").write_text(build_svg(geography), encoding="utf-8")
    print(f"Created a country map for {len(latest)} observations from snapshot {record['snapshot_date']}.")


if __name__ == "__main__":
    main()
