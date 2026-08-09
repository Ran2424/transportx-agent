# Heatmap: Quantile Clipping for Color Scales

**Style name**: `heatmap_quantile_clipping`  
**Type**: 2-D density / heatmap guideline (no single repro script)  
**Use when**: plotting spatial heatmaps, hexbin density maps, or 2-D histograms where a few extreme locations would otherwise saturate the colorbar.

## Common mistake

A raw `hexbin` or `hist2d` color scale uses the full data range (`min` to `max`). In ride-hailing, metro, or road-congestion heatmaps, a single venue or hot pixel can push the upper limit to thousands, making the rest of the map look blank. At the same time, near-zero outliers or empty cells can make the lower end noisy.

## Rule of thumb

Clip the color scale to a percentile band. The exact percentile should be **explored**, not hard-coded. For most geospatial heatmaps, **only three upper thresholds need to be tested**: 95%, 98%, and 99%.

Why these three?

- **95%** corresponds roughly to a two-tailed 95% confidence interval (≈ ±2σ in a normal distribution). Use this when the data is moderately skewed and you want a clean, conservative map.
- **98%** sits between the routine 95% and the extreme 99%. It is often the sweet spot for highly skewed spatial counts: it keeps the dominant hot area visible while still revealing secondary warm areas.
- **99%** corresponds roughly to a two-tailed 99% confidence interval (≈ ±3σ). Use this when the distribution has very heavy tails or when the peak itself is part of the story.

Lower-clip guidance:

- **Lower clip**: usually at the 1st–5th percentile to suppress sparse/noisy tails. For already dense data, 0% (no lower clip) may be fine.
- If the lower tail is uninteresting empty counts, set `mincnt=1` and leave `vmin` unset.

Selection process:

1. Compute the non-empty bin counts as shown below.
2. Calculate `vmax` for p = 95, 98, 99 (and `vmin` for 100−p if needed).
3. Choose the threshold where:
   - The main hot area is clearly visible.
   - Secondary and tertiary warm areas are not flattened to the background.
   - No single cell or small cluster dominates the entire color range.
4. State the chosen clip in the caption, e.g., "Order count (2%–98% clip)."

There is no need to render side-by-side panels for every candidate; the decision can be made by comparing the resulting `vmax` values against the raw data range and the spatial story you want to tell.

## How to compute the clip values

For hexbin plots, the counts are not known until the hexagonal grid is built. Pre-compute the counts with a temporary figure:

```python
import matplotlib.pyplot as plt
import numpy as np

def hexbin_counts(lon, lat, gridsize=80, extent=None):
    fig_tmp = plt.figure()
    ax_tmp = fig_tmp.add_subplot(111)
    hb = ax_tmp.hexbin(lon, lat, gridsize=gridsize, extent=extent, mincnt=1)
    counts = hb.get_array()
    plt.close(fig_tmp)
    return counts

counts = hexbin_counts(lon, lat, gridsize=80, extent=(xmin, xmax, ymin, ymax))

# Try the three standard upper thresholds
for p in [95, 98, 99]:
    vmin = np.percentile(counts, 100 - p)
    vmax = np.percentile(counts, p)
    print(f'{p}%: vmin={vmin:.1f}, vmax={vmax:.1f}')

# Choose the best p based on the spatial story and the raw range
vmin = np.percentile(counts, 2)   # example: lower 2%
vmax = np.percentile(counts, 98)  # example: upper 98%
```

Then draw the real plot with the chosen clipped range:

```python
hb = ax.hexbin(lon, lat, gridsize=80, cmap='YlOrRd', vmin=vmin, vmax=vmax, mincnt=1)
```

## When comparing multiple panels/days

If you need two panels to be comparable, compute the clip values on the **combined** counts:

```python
all_counts = np.concatenate([
    hexbin_counts(lon_day1, lat_day1),
    hexbin_counts(lon_day2, lat_day2),
])
# Explore p = 95, 98, 99
p = 95  # or 98, depending on the distribution
vmin = np.percentile(all_counts, 100 - p)
vmax = np.percentile(all_counts, p)

# Use the same vmin/vmax for both panels
hb1 = ax1.hexbin(lon_day1, lat_day1, vmin=vmin, vmax=vmax, ...)
hb2 = ax2.hexbin(lon_day2, lat_day2, vmin=vmin, vmax=vmax, ...)
```

## Visual style notes

- Use a perceptually uniform or sequential colormap (`YlOrRd`, `Blues`, `magma`, `viridis`). Avoid `jet`.
- Add a basemap boundary (e.g., Shapefile or GeoJSON) with thin gray lines so the heatmap has spatial context.
- Mark key POIs with a contrasting symbol (e.g., red star) and label.
- Add a colorbar label that explicitly states the clipping policy, e.g., "Order count (2%–98% clip)".

## Caveats

- Clipping hides the absolute peak value. If the peak is the main story, show it separately or use an inset.
- Do not clip when the data is already bounded (e.g., probabilities in [0, 1]).
- For spatial data with very different densities across panels, consider per-panel clipping and add a clear note.
- If the data distribution is multimodal, a single percentile clip may not be enough; consider log scaling or adaptive binning.
