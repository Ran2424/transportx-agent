---
name: geo-visualization-explanation
description: Build and debug declarative interactive Web GIS maps in Tau with publish_geodata and present_visualization. Use for GeoJSON publication, point/line/polygon layers, spatial hotspots, thematic styling, POI reference layers, layer switching, selection, or any Invalid GeoScene failure. Do not use for ordinary static matplotlib charts.
---

# Geo Visualization Explanation

Use the Tau Geo tools to publish session-scoped GeoJSON and present a declarative 2D map. Keep data preparation, map description, and Web rendering separate.

## Choose the workflow

- Always use `publish_geodata` followed by `present_visualization`. The presentation tool accepts command-style parameters and builds GeoScene internally; do not hand-write a `scene`, `sources`, `layers`, or `encoding` object.
- Aggregate dense observations before publication. `publish_geodata` accepts at most 50,000 features and 20 MiB; do not send a million raw points to the browser.
- Read `shanghai-traffic-data-assets` as well when the map uses the governed Shanghai traffic databases. Keep its metric, entity, and CRS rules authoritative.

## Prepare GeoJSON

1. Convert source coordinates to WGS84 longitude/latitude before visualization. Do not expect the tools to convert GCJ-02 or BD-09.
2. Validate coordinate order and range: `[longitude, latitude]`, longitude within `[-180, 180]`, latitude within `[-90, 90]`.
3. Give every feature a stable unique top-level `Feature.id`, or add a unique string/integer property and pass its name as `idField`.
4. Keep lines, ordinary points, highlighted POIs, and different thematic groups in separate sources when they require different styling; GeoScene v1 has no filter channel.
5. Write generated GeoJSON inside the current task directory before calling `publish_geodata`.
6. Before publication, verify the root type, feature count, file size, geometry types, coordinate range, and ID uniqueness. Keep the result below 50,000 features and 20 MiB; increase aggregation size before publishing when it exceeds either limit.

When using GeoPandas with `idField: "id"`, create the property explicitly before export:

```python
grid["id"] = grid.index.astype(str)
```

Do not rely on a DataFrame index becoming a GeoJSON property automatically.

## Publish data

Call `publish_geodata` with the relative GeoJSON path, a clear title, and `idField` when using a property ID. Reuse the returned `resourceId` exactly in a `geojson-resource` source.

If publication fails, fix the data instead of removing a meaningful `idField`:

- Missing ID: ensure every feature contains the property.
- Duplicate ID: generate deterministic unique values.
- Invalid coordinates: correct the CRS or coordinate order.
- Excessive size: aggregate, simplify, or split the data.

## Build the map incrementally

Start with the resource returned by `publish_geodata` and one constant-style layer:

```json
{
  "command": "create_map",
  "visualizationId": "hotspot_map",
  "title": "热点分布",
  "resourceId": "geo_REPLACE_ME",
  "sourceId": "hotspots",
  "layerId": "hotspot_fill",
  "layerType": "fill",
  "layerTitle": "热点",
  "color": "#2563eb"
}
```

After `create_map` succeeds, add one concern per command in this order:

1. `set_step`, `set_continuous`, `set_categorical`, or `set_constant` for one channel.
2. `add_layer` for a second source/layer or reference POI layer.
3. `set_popup` for details.
4. `set_controls` for navigation, legend, layerSwitcher, fullscreen, or fitToData.
5. `set_metadata` for descriptions and warnings.
6. `set_camera` or `fit_bounds` only when the automatically derived resource extent is unsuitable.

Reuse the same `visualizationId` while refining the map. When the user says “add”, “overlay”, “mark”, or “include” something in the current map, update that visualization instead of creating a second map. Create a new ID only when the user explicitly asks for a separate map.

## Follow encoding constraints

- Use color hex strings such as `#2563eb`, `#fff`, `#2563ebcc`, or `#fffc`. Do not use `rgb(...)`, `rgba(...)`, CSS variables, URLs, or named colors.
- Use numeric opacity in `[0, 1]`.
- Provide 2–16 strictly ascending numeric stops for `step` and `continuous`.
- Include `default` for `step`; do not include it for `continuous`.
- Use only the channels supported by the layer type:
  - `circle`: `color`, `radius`, `opacity`, `strokeColor`, `strokeWidth`
  - `line`: `color`, `width`, `opacity`, `dash`
  - `fill`: `color`, `opacity`, `outlineColor`
  - `label`: `textField`, `color`, `size`, `haloColor`, `haloWidth`
- Pass the channel and its values to the matching command. For example, use `command: "set_constant"`, `channel: "opacity"`, `value: 0.75`; never construct VisualValue, MapLibre `paint`, `layout`, or JavaScript expressions yourself.

## Compose readable thematic maps

- Default only one overlapping fill layer to `visible: true`; set alternatives to `visible: false` and enable `layerSwitcher`.
- Add a reference POI or label layer when the user needs to understand hotspot position relative to a venue or station.
- Prefer clear layer titles and short popup fields.
- Use a bounds view with padding when the source extent is known; use a camera view for a deliberate fixed composition.
- Explain time range, spatial scope, aggregation unit, CRS, and important coverage limitations in the response.

## Recover from validation failures

When `present_visualization` rejects a command:

1. Preserve the last successful scene.
2. Read the returned validation issue path and code; change only that command parameter.
3. Check color format, channel name, stop ordering, source/layer id, bounds, and popup format.
4. Retry `create_map` with one constant-style layer if no previous map succeeded.
5. Add commands back one at a time after the minimal map succeeds.
6. If the same `visualizationId + command + layerId + channel` fails twice with the same field path, stop retrying it. Preserve the last successful scene and report the tool failure instead of guessing more values.

Do not repeatedly submit unrelated rewrites. Treat the tool's field-specific error as authoritative when one is available.
