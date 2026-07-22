#!/usr/bin/env python3
"""
=============================================================================
NOTE FOR DEVELOPER (read first):
This script is REFERENCE LOGIC, not a drop-in. It was written against the
ORIGINAL source files while building the zones:
  - downtown_zones_DRAFT.geojson (only 3 downtown boxes)
  - Current_City_of_Detroit_Neighborhoods...geojson (raw City data)
  - detroit_venues_clean.csv (venue list)

For the actual build, use the CONSOLIDATED file instead:
  ->  foreshift_13_zones.geojson  (all 13 final zones, canonical names)

This script shows the ASSIGNMENT APPROACH you should replicate:
  - priority order (downtown sub-zones first, then Downtown Core, then rest)
  - the Southwest Detroit grouping (4 neighborhoods -> one zone)
  - point-in-polygon containment test
Implement the same logic against foreshift_13_zones.geojson.
=============================================================================
"""

import csv, json, sys
from collections import Counter

try:
    from shapely.geometry import shape, Point
    from shapely.ops import unary_union
except ImportError:
    sys.exit("Need shapely: pip install shapely")

OFFICIAL = "Current_City_of_Detroit_Neighborhoods_-37248265170297756.geojson"
DOWNTOWN = "downtown_zones_DRAFT.geojson"
VENUES   = "detroit_venues_clean.csv"

# Your in-scope zones. Some zones GROUP several official neighborhoods into one.
# Single-neighborhood zones:
KEEP_OFFICIAL = {
    "Midtown", "Corktown", "Eastern Market", "New Center",
    "Core City", "Greektown", "Mexicantown",
}
# Grouped zones: one zone name -> list of official neighborhoods that compose it
# Mexicantown is its OWN standalone zone (above); Southwest Detroit = the surrounding neighborhoods
ZONE_GROUPS = {
    "Southwest Detroit": ["Hubbard Farms", "Hubbard Richard",
                           "Central Southwest", "Springwells"],
}
# build reverse lookup: official neighborhood -> zone name
GROUP_LOOKUP = {}
for zone_name, members in ZONE_GROUPS.items():
    for m in members:
        GROUP_LOOKUP[m] = zone_name

# ---- load your 3 drawn downtown boxes ----
with open(DOWNTOWN, encoding="utf-8") as f:
    dgj = json.load(f)
downtown_zones = []
for feat in dgj["features"]:
    name = feat["properties"].get("zone", "Unnamed")
    downtown_zones.append((name, shape(feat["geometry"])))
print(f"  loaded {len(downtown_zones)} downtown boxes: {[n for n,_ in downtown_zones]}")

# ---- load official neighborhoods ----
with open(OFFICIAL, encoding="utf-8") as f:
    ogj = json.load(f)
official = {}
downtown_poly = None
for feat in ogj["features"]:
    nm = feat["properties"].get("nhood_name")
    geom = feat.get("geometry")
    if not geom: continue
    poly = shape(geom)
    official[nm] = poly
    if nm == "Downtown":
        downtown_poly = poly
print(f"  loaded {len(official)} official neighborhoods (Downtown polygon found: {downtown_poly is not None})")

# ---- load venues ----
venues = []
with open(VENUES, encoding="utf-8") as f:
    for row in csv.DictReader(f):
        try:
            lat = float(row["latitude"]); lng = float(row["longitude"])
        except (ValueError, KeyError):
            continue
        venues.append({**row, "lat": lat, "lng": lng})
print(f"  loaded {len(venues)} venues")

# ---- assign ----
def assign(v):
    pt = Point(v["lng"], v["lat"])
    # 1. drawn downtown boxes first
    for name, poly in downtown_zones:
        if poly.contains(pt):
            return name
    # 2. inside official Downtown but not in a box -> catch-all
    if downtown_poly is not None and downtown_poly.contains(pt):
        return "Downtown Detroit"
    # 3. a grouped zone (e.g. Southwest Detroit = several neighborhoods)
    for nm, zone_name in GROUP_LOOKUP.items():
        if nm in official and official[nm].contains(pt):
            return zone_name
    # 4. a kept single-neighborhood zone
    for nm in KEEP_OFFICIAL:
        if nm in official and official[nm].contains(pt):
            return nm
    # 5. any other official neighborhood -> OUT OF SCOPE
    for nm, poly in official.items():
        if poly.contains(pt):
            return "Out of Scope"
    return "Out of Scope"

for v in venues:
    v["zone"] = assign(v)

counts = Counter(v["zone"] for v in venues)

# ---- write venue+zone csv ----
with open("venues_with_zones.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["name","address","latitude","longitude","category","zone"])
    for v in venues:
        w.writerow([v.get("name",""), v.get("address",""), v["lat"], v["lng"], v.get("category",""), v["zone"]])

# ---- write zone counts ----
with open("zone_counts.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["zone","venue_count"])
    for z, c in counts.most_common():
        w.writerow([z, c])

# ---- print summary ----
print("\n  === IN-SCOPE VENUE COUNT PER ZONE ===")
inscope = [(z,c) for z,c in counts.most_common() if z != "Out of Scope"]
oos = counts.get("Out of Scope", 0)
for z, c in inscope:
    print(f"    {z:22s} {c}")
inscope_total = sum(c for _,c in inscope)
print(f"    {'-'*30}")
print(f"    {'IN-SCOPE TOTAL':22s} {inscope_total}")
print(f"    {'Out of Scope':22s} {oos}")
print(f"    {'GRAND TOTAL':22s} {len(venues)}")

# ---- build HTML map (Leaflet) ----
zone_colors = {}
palette = ["#e6194B","#3cb44b","#4363d8","#f58231","#911eb4","#42d4f4","#f032e6",
           "#bfef45","#fabed4","#469990","#dcbeff","#9A6324","#800000","#808000"]
all_zones = [z for z,_ in counts.most_common()]
for i, z in enumerate(all_zones):
    zone_colors[z] = palette[i % len(palette)]

# downtown box geometries as geojson for the map
box_geo = [{"name":n, "coords": list(p.exterior.coords)} for n,p in downtown_zones]

# ALSO draw the official zone boundaries (Midtown, Corktown, Greektown, etc.) + Downtown polygon
official_geo = []
def ring_coords(poly):
    # handle Polygon and MultiPolygon
    try:
        return [list(poly.exterior.coords)]
    except AttributeError:
        rings=[]
        for g in poly.geoms:
            rings.append(list(g.exterior.coords))
        return rings
draw_names = list(KEEP_OFFICIAL) + ["Downtown"] + list(GROUP_LOOKUP.keys())
for nm in draw_names:
    if nm in official:
        label = GROUP_LOOKUP.get(nm, nm)
        for ring in ring_coords(official[nm]):
            official_geo.append({"name":label, "coords":ring})

pts_js = [{"lat":v["lat"],"lng":v["lng"],"z":v["zone"],"n":v.get("name","")[:40],"c":v.get("category","")} for v in venues if v["zone"] != "Out of Scope"]

html = """<!DOCTYPE html><html><head><meta charset="utf-8">
<title>ForeShift Detroit Zones</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>body{margin:0}#map{height:100vh}.legend{background:white;padding:8px;font:12px sans-serif;line-height:18px}</style>
</head><body><div id="map"></div><script>
var map=L.map('map').setView([42.3450,-83.0550],13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'',maxZoom:19}).addTo(map);
var colors=__COLORS__;
var pts=__PTS__;
var boxes=__BOXES__;
var official=__OFFICIAL__;
official.forEach(function(b){
  var latlngs=b.coords.map(function(c){return [c[1],c[0]];});
  L.polygon(latlngs,{color:'#666',weight:1.5,fill:false,dashArray:'4'}).addTo(map).bindTooltip(b.name,{permanent:true,direction:'center',className:'zlabel'});
});
boxes.forEach(function(b){
  var latlngs=b.coords.map(function(c){return [c[1],c[0]];});
  L.polygon(latlngs,{color:'#000',weight:3,fill:false}).addTo(map).bindTooltip(b.name,{permanent:true,direction:'center',className:'zlabel'});
});
pts.forEach(function(p){
  L.circleMarker([p.lat,p.lng],{radius:3,color:colors[p.z]||'#888',fillOpacity:0.7,weight:1})
    .addTo(map).bindPopup(p.n+'<br>'+p.c+'<br><b>'+p.z+'</b>');
});
var legend=L.control({position:'bottomright'});
legend.onAdd=function(){var d=L.DomUtil.create('div','legend');d.innerHTML='<b>Zones</b><br>';
for(var z in colors){d.innerHTML+='<span style="color:'+colors[z]+'">&#9679;</span> '+z+'<br>';}return d;};
legend.addTo(map);
</script></body></html>"""
html = html.replace("__COLORS__", json.dumps(zone_colors)).replace("__PTS__", json.dumps(pts_js)).replace("__BOXES__", json.dumps(box_geo)).replace("__OFFICIAL__", json.dumps(official_geo))
with open("zone_map.html","w",encoding="utf-8") as f:
    f.write(html)
print("\n  written -> venues_with_zones.csv, zone_counts.csv, zone_map.html")
print("  Open zone_map.html in your browser to SEE the zones + venues.")
