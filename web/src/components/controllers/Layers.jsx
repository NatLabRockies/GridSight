import React, { useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import Typography from "@mui/material/Typography";
import GenericLayerStyler from "./GenericLayerStyler.jsx";
import AddLayerDialog from "./AddLayerDialog.jsx";
import { useConfirm } from "../../lib/dialogs.jsx";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import AddIcon from "@mui/icons-material/Add";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Tooltip from "@mui/material/Tooltip";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { deleteLayer } from "../../lib/loaders.js";

export default function LayerFactory({
  // Generic layer props
  scenarioProp,
  genericLayers,
  genericLayerVisibility,
  onGenericLayerVisibilityChange,
  onGenericLayerAdded,
  genericLayerLocalStyle,
  onGenericLayerLocalStyleChange,
  onGenericLayerStyleMappingChange,
  onGenericLayerDeleted,
  genericLayerGeo,
  genericLayerData,
  onAskAI,
  onPopoutLegend,
  onQuickStyleOpen,
  anchoredLayers,
  onAnchorToggle,
  // When true, drop the sidebar chrome (surrounding Paper, primary-color
  // "Layers" banner). The caller already provides its own title bar —
  // e.g. a ChartFrame in a panel host — so a second header looks noisy.
  embedded = false,
}) {
  const [addLayerOpen, setAddLayerOpen] = useState(false);
  const [deletingLayerId, setDeletingLayerId] = useState(null);
  const confirm = useConfirm();

  const Wrapper = embedded ? Box : Paper;
  const wrapperProps = embedded
    ? { sx: { width: '100%', height: '100%', overflowX: 'hidden', overflowY: 'auto' } }
    : { elevation: 1,
        sx: { minWidth: 280, maxWidth: 620, maxHeight: 800, overflowX: 'hidden', overflowY: 'auto', borderRadius: 2 } };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <>
          <Stack direction="row" alignItems="center" bgcolor="primary.main" sx={{ px: 1, py: 0.25 }}>
            <Typography
              variant="subtitle1"
              fontWeight={600}
              color="primary.contrastText"
              sx={{ flex: 1, textAlign: "center" }}
            >
              Layers
            </Typography>
            {onQuickStyleOpen && (
              <Tooltip title="Open quick layer styling panel">
                <IconButton size="small" sx={{ color: "primary.contrastText" }} onClick={onQuickStyleOpen}>
                  <OpenInNewIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          <Divider />
        </>
      )}

      {/* ── Generic DB-backed layers ────────────────────────────────────
          Layers tagged with `default_style.group_key` collapse into one
          row with that key as the leader (first layer in the group's
          insertion order). Subsequent members are skipped at the loop
          level — they're surfaced via per-member sub-toggle chips
          (T / R / …) inside the leader's row. */}
      {(genericLayers ?? []).map((layer, _idx, allLayers) => {
        const groupKey = layer.default_style?.group_key;
        let groupMembersList = null;
        if (groupKey) {
          groupMembersList = allLayers.filter(l => l.default_style?.group_key === groupKey);
          if (groupMembersList[0].id !== layer.id) return null;
        }
        const visible = genericLayerVisibility?.[layer.id] !== false;
        return (
          <Box key={`generic-${layer.id}`} sx={{ mb: 0.5 }}>
            <Accordion sx={{ width: "100%", overflow: "hidden" }}>
              <AccordionSummary expandIcon={<ArrowDropDownIcon />}>
                <Stack direction="row" alignItems="center" sx={{ flex: 1, minWidth: 0, mr: 1 }}>
                  <Typography variant="body2" fontWeight={500} noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {(groupMembersList && layer.default_style?.group_display_name) || layer.display_name || layer.name}
                  </Typography>
                  {/* Info affordance — surfaces the dataset/geometry description
                      (authored by the user or AI in the Data Catalog) on hover.
                      Only rendered when a description actually exists so rows
                      without context stay clean. */}
                  {(() => {
                    const geoDesc = layer.geometry?.description;
                    const dsDescs = (layer.layer_datasets ?? [])
                      .map(ld => ld.dataset)
                      .filter(ds => ds?.description)
                      .map(ds => ({ name: ds.display_name || ds.name, desc: ds.description }));
                    const layerDesc = layer.description;
                    if (!geoDesc && !layerDesc && dsDescs.length === 0) return null;
                    const tip = (
                      <Box sx={{ maxWidth: 320 }}>
                        {layerDesc && (
                          <Typography variant="caption" sx={{ display: "block", mb: geoDesc || dsDescs.length ? 0.75 : 0 }}>
                            {layerDesc}
                          </Typography>
                        )}
                        {geoDesc && (
                          <Box sx={{ mb: dsDescs.length ? 0.75 : 0 }}>
                            <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>
                              {layer.geometry?.display_name || layer.geometry?.name || "Geometry"}
                            </Typography>
                            <Typography variant="caption" sx={{ display: "block", color: "grey.300" }}>{geoDesc}</Typography>
                          </Box>
                        )}
                        {dsDescs.map((d, i) => (
                          <Box key={i} sx={{ mb: i < dsDescs.length - 1 ? 0.75 : 0 }}>
                            <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>{d.name}</Typography>
                            <Typography variant="caption" sx={{ display: "block", color: "grey.300" }}>{d.desc}</Typography>
                          </Box>
                        ))}
                      </Box>
                    );
                    return (
                      <Tooltip title={tip} arrow>
                        <InfoOutlinedIcon
                          fontSize="small"
                          onClick={(e) => e.stopPropagation()}
                          sx={{ ml: 0.5, opacity: 0.5, cursor: "help", "&:hover": { opacity: 0.9 } }}
                        />
                      </Tooltip>
                    );
                  })()}
                  {/* Group-wide controls: anchor / visibility / delete fan
                      out across every member when this row represents a
                      collapsed group. Otherwise they're per-layer (legacy). */}
                  <Tooltip title={anchoredLayers?.has(layer.id) ? "Unlock layer (allow AI changes)" : "Lock layer (prevent AI changes)"}>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        const targets = groupMembersList ?? [layer];
                        for (const m of targets) onAnchorToggle?.(m.id);
                      }}
                      sx={{ opacity: anchoredLayers?.has(layer.id) ? 0.9 : 0.3, ml: 0.5 }}
                    >
                      {anchoredLayers?.has(layer.id) ? <LockIcon fontSize="small" color="warning" /> : <LockOpenIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                  {/* Per-member visibility chips (T / R / …) when grouped. */}
                  {groupMembersList && groupMembersList.map((m) => {
                    const memberVis = genericLayerVisibility?.[m.id] !== false;
                    const role = m.default_style?.group_role || m.display_name || m.name;
                    const lbl = m.default_style?.group_role_label || role[0]?.toUpperCase() || "?";
                    return (
                      <Tooltip key={m.id} title={`${role}: ${memberVis ? "shown" : "hidden"}`}>
                        <Chip
                          label={lbl}
                          size="small"
                          color={memberVis ? "primary" : "default"}
                          variant={memberVis ? "filled" : "outlined"}
                          onClick={(e) => {
                            e.stopPropagation();
                            onGenericLayerVisibilityChange?.(m.id, !memberVis);
                          }}
                          sx={{ ml: 0.5, height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
                        />
                      </Tooltip>
                    );
                  })}
                  {/* Sub-toggles for GeneratorLayer (gen / cap / curt visibility).
                      Curtailment chip is gated on `curtailmentApplicable` so
                      it's hidden from layers where it's meaningless (e.g.
                      thermal generators don't curtail in the dispatch sense). */}
                  {layer.deck_layer_type === 'GeneratorLayer' && (() => {
                    const cur = genericLayerLocalStyle?.[layer.id] ?? {};
                    const genOn  = cur.generationVisible  ?? true;
                    const capOn  = cur.capacityVisible    ?? true;
                    const curtOn = cur.curtailmentVisible ?? false;
                    const curtApplicable = cur.curtailmentApplicable === true;
                    return (
                      <>
                        <Tooltip title={`Generation: ${genOn ? "shown" : "hidden"}`}>
                          <Chip
                            label="G"
                            size="small"
                            color={genOn ? "primary" : "default"}
                            variant={genOn ? "filled" : "outlined"}
                            onClick={(e) => {
                              e.stopPropagation();
                              onGenericLayerLocalStyleChange?.(layer.id, { ...cur, generationVisible: !genOn });
                            }}
                            sx={{ ml: 0.5, height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
                          />
                        </Tooltip>
                        <Tooltip title={`Capacity: ${capOn ? "shown" : "hidden"}`}>
                          <Chip
                            label="C"
                            size="small"
                            color={capOn ? "secondary" : "default"}
                            variant={capOn ? "filled" : "outlined"}
                            onClick={(e) => {
                              e.stopPropagation();
                              onGenericLayerLocalStyleChange?.(layer.id, { ...cur, capacityVisible: !capOn });
                            }}
                            sx={{ ml: 0.5, height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
                          />
                        </Tooltip>
                        {curtApplicable && (
                          <Tooltip title={`Curtailment (capacity − generation as a grey band): ${curtOn ? "shown" : "hidden"}`}>
                            <Chip
                              label="X"
                              size="small"
                              // Neutral chip color so the visual hints at the
                              // grey band the toggle produces in the layer.
                              color="default"
                              variant={curtOn ? "filled" : "outlined"}
                              onClick={(e) => {
                                e.stopPropagation();
                                onGenericLayerLocalStyleChange?.(layer.id, { ...cur, curtailmentVisible: !curtOn });
                              }}
                              sx={{
                                ml: 0.5, height: 22,
                                '& .MuiChip-label': { px: 1, fontSize: 11 },
                                ...(curtOn && { bgcolor: 'grey.500', color: 'common.white' }),
                              }}
                            />
                          </Tooltip>
                        )}
                      </>
                    );
                  })()}
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Group eye toggles every member to the *opposite of
                      // the leader's* state. Per-member chips above stay
                      // available for finer control.
                      const targets = groupMembersList ?? [layer];
                      const next = !visible;
                      for (const m of targets) onGenericLayerVisibilityChange?.(m.id, next);
                    }}
                    sx={{ opacity: visible ? 0.8 : 0.4, ml: 0.5 }}
                  >
                    {visible ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
                  </IconButton>
                  <Tooltip title={groupMembersList ? "Delete grouped layers (keeps underlying data)" : "Delete layer (keeps underlying data)"}>
                    <IconButton
                      size="small"
                      color="error"
                      disabled={deletingLayerId === layer.id}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const targets = groupMembersList ?? [layer];
                        const promptName = groupMembersList
                          ? (layer.default_style?.group_display_name || "this group")
                          : `"${layer.name}"`;
                        const ok = await confirm({
                          title: `Delete ${promptName}?`,
                          message: 'The geometry and dataset files will not be deleted.',
                          confirmText: 'Delete',
                          destructive: true,
                        });
                        if (!ok) return;
                        setDeletingLayerId(layer.id);
                        try {
                          for (const m of targets) {
                            // Run sequentially so a partial failure leaves
                            // the FE state coherent (each onGenericLayerDeleted
                            // updates the layer list, which the next iter
                            // observes).
                            // eslint-disable-next-line no-await-in-loop
                            await deleteLayer(m.id);
                            onGenericLayerDeleted?.(m.id);
                          }
                        } catch (e2) {
                          console.error("[Layers] deleteLayer error:", e2);
                        } finally {
                          setDeletingLayerId(null);
                        }
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 1 }}>
                {/* Layer info chips */}
                <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: "wrap", gap: 0.5 }}>
                  <Chip label={layer.deck_layer_type} size="small" color="primary" variant="outlined" />
                  {layer.layer_datasets?.map(ld => (
                    <Chip
                      key={ld.id}
                      label={ld.dataset?.name ?? "dataset"}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Stack>
                {/* ── Tech-category filter ───────────────────────────────
                    Union of display-group categories across group members
                    (or just this layer when not grouped). The chips are
                    multi-select; on toggle we write filterProperty +
                    filterCategories into localStyle, which broadcasts
                    across the group via App.jsx's group-aware setter. */}
                {(() => {
                  const sourceLayers = groupMembersList ?? [layer];
                  const cats = new Map(); // category → hex color (last write wins)
                  for (const m of sourceLayers) {
                    const cc = m.default_style?.geoMappings?.getFillColor?.categoryColors;
                    if (cc && typeof cc === 'object') {
                      for (const [k, v] of Object.entries(cc)) cats.set(k, v);
                    }
                  }
                  if (cats.size === 0) return null;
                  const cur = genericLayerLocalStyle?.[layer.id] ?? {};
                  const property = cur.filterProperty ?? 'display_group';
                  // Three states for the filter, decided by (filterEnabled,
                  // filterCategories):
                  //   filter off                       → all categories shown
                  //   filter on, categories=[]         → none shown (None chip)
                  //   filter on, categories=[a, b, …]  → only those shown
                  const filterOn = cur.filterEnabled === true;
                  const explicit = Array.isArray(cur.filterCategories) ? cur.filterCategories : null;
                  const allOn = !filterOn;
                  const noneOn = filterOn && explicit && explicit.length === 0;
                  const isOn = (cat) => allOn || (explicit?.includes(cat) ?? false);

                  const setAll = () => onGenericLayerLocalStyleChange?.(layer.id, {
                    ...cur, filterEnabled: false, filterCategories: null,
                  });
                  const setNone = () => onGenericLayerLocalStyleChange?.(layer.id, {
                    ...cur, filterEnabled: true, filterProperty: property, filterCategories: [],
                  });
                  const toggleCat = (cat) => {
                    let nextActive;
                    if (allOn) {
                      // First click from "All" mode — keep everything except
                      // the just-clicked category visible.
                      nextActive = Array.from(cats.keys()).filter(c => c !== cat);
                    } else if (explicit?.includes(cat)) {
                      nextActive = explicit.filter(c => c !== cat);
                    } else {
                      nextActive = [...(explicit ?? []), cat];
                    }
                    onGenericLayerLocalStyleChange?.(layer.id, {
                      ...cur,
                      filterEnabled: true,
                      filterProperty: property,
                      filterCategories: nextActive,
                    });
                  };
                  return (
                    <Box sx={{ mb: 1 }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                        <Typography variant="caption" sx={{ minWidth: 50 }}>Tech</Typography>
                        <Tooltip title="Show all categories (filter off)">
                          <Chip
                            label="All"
                            size="small"
                            color={allOn ? "primary" : "default"}
                            variant={allOn ? "filled" : "outlined"}
                            onClick={setAll}
                            sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
                          />
                        </Tooltip>
                        <Tooltip title="Hide all categories">
                          <Chip
                            label="None"
                            size="small"
                            color={noneOn ? "primary" : "default"}
                            variant={noneOn ? "filled" : "outlined"}
                            onClick={setNone}
                            sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
                          />
                        </Tooltip>
                      </Stack>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {Array.from(cats.entries()).map(([cat, color]) => (
                          <Chip
                            key={cat}
                            label={cat}
                            size="small"
                            variant={isOn(cat) ? "filled" : "outlined"}
                            onClick={() => toggleCat(cat)}
                            sx={{
                              height: 22,
                              '& .MuiChip-label': { px: 1, fontSize: 11 },
                              ...(isOn(cat) && { bgcolor: color, color: '#fff' }),
                            }}
                          />
                        ))}
                      </Box>
                    </Box>
                  );
                })()}
                {/* TransmissionLayer color/threshold controls.
                    - Color mode: piecewise grey/orange/red OR a continuous colormap.
                    - Threshold slider: in piecewise mode, sets the orange and red
                      colour boundaries; in colormap mode, only the lower thumb
                      (orangeThreshold) matters — it's the loading at which sub-
                      threshold alpha saturates.
                    - Unstressed alpha: ceiling on the alpha ramp for sub-threshold
                      lines (lower = fainter low-loading lines, high-loading lines pop). */}
                {layer.deck_layer_type === 'TransmissionLayer' && (() => {
                  const cur = genericLayerLocalStyle?.[layer.id] ?? {};
                  const orange = cur.orangeThreshold ?? 0.85;
                  const red = cur.redThreshold ?? 0.95;
                  const colorMode = cur.colorMode ?? 'piecewise';
                  const greyAlphaMax = cur.greyAlphaMax ?? 1.0;
                  const isPiecewise = colorMode === 'piecewise';
                  const marks = [
                    { value: 0.75, label: '75' },
                    { value: 0.80, label: '80' },
                    { value: 0.85, label: '85' },
                    { value: 0.90, label: '90' },
                    { value: 0.95, label: '95' },
                  ];
                  return (
                    <Stack spacing={1} sx={{ mb: 1.5, px: 1 }}>
                      {/* Color mode selector */}
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Typography variant="caption" sx={{ minWidth: 90 }}>Color</Typography>
                        <Select
                          size="small"
                          value={colorMode}
                          onChange={(e) =>
                            onGenericLayerLocalStyleChange?.(layer.id, { ...cur, colorMode: e.target.value })
                          }
                          sx={{ flex: 1, fontSize: 12, '& .MuiSelect-select': { py: 0.5 } }}
                        >
                          <MenuItem value="piecewise">Piecewise (grey/orange/red)</MenuItem>
                          <MenuItem value="plasma">Plasma</MenuItem>
                          <MenuItem value="viridis">Viridis</MenuItem>
                          <MenuItem value="coolwarm">Coolwarm</MenuItem>
                          <MenuItem value="rdylgn">RdYlGn</MenuItem>
                          <MenuItem value="loading">Loading (green→red)</MenuItem>
                        </Select>
                      </Stack>

                      {/* Threshold + unstressed-alpha sliders are piecewise-only.
                          Continuous colormaps (viridis/plasma/etc.) define color
                          AND alpha directly from loading, so these knobs don't
                          apply. */}
                      {isPiecewise && (
                        <>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Typography variant="caption" sx={{ minWidth: 140, lineHeight: 1.2 }}>
                              Stress &gt; {Math.round(orange * 100)}%<br/>Overload &gt; {Math.round(red * 100)}%
                            </Typography>
                            <Slider
                              size="small"
                              min={0}
                              max={1}
                              step={0.01}
                              marks={marks}
                              value={[orange, red]}
                              disableSwap
                              onChange={(_, v) => {
                                const [o, r] = v;
                                onGenericLayerLocalStyleChange?.(layer.id, {
                                  ...cur, orangeThreshold: o, redThreshold: r,
                                });
                              }}
                              sx={{
                                '& .MuiSlider-markLabel': { fontSize: 10, top: 18 },
                                '& .MuiSlider-mark': { height: 6 },
                              }}
                            />
                          </Stack>

                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Typography variant="caption" sx={{ minWidth: 140 }}>
                              Unstressed alpha {Math.round(greyAlphaMax * 100)}%
                            </Typography>
                            <Slider
                              size="small"
                              min={0}
                              max={1}
                              step={0.05}
                              value={greyAlphaMax}
                              onChange={(_, v) =>
                                onGenericLayerLocalStyleChange?.(layer.id, { ...cur, greyAlphaMax: v })
                              }
                            />
                          </Stack>
                        </>
                      )}
                    </Stack>
                  );
                })()}
                <GenericLayerStyler
                  layerConfig={layer}
                  geoData={genericLayerGeo?.[layer.id] ?? null}
                  layerData={genericLayerData?.[layer.id] ?? null}
                  localStyle={genericLayerLocalStyle?.[layer.id] ?? {}}
                  onLocalStyleChange={(style) => onGenericLayerLocalStyleChange?.(layer.id, style)}
                  onStyleMappingsChange={(mappings) => onGenericLayerStyleMappingChange?.(layer.id, mappings)}
                  onAskAI={onAskAI}
                  onPopoutLegend={onPopoutLegend}
                />
              </AccordionDetails>
            </Accordion>
          </Box>
        );
      })}

      {/* ── Add Layer button ──────────────────────────────────────────── */}
      <Box sx={{ m: 1 }}>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          fullWidth
          onClick={() => setAddLayerOpen(true)}
          disabled={!scenarioProp?.project || !scenarioProp?.scenario}
        >
          Add Layer
        </Button>
        {(!scenarioProp?.project || !scenarioProp?.scenario) && (
          <Typography variant="caption" color="text.secondary">
            Select a scenario first
          </Typography>
        )}
      </Box>

      <AddLayerDialog
        open={addLayerOpen}
        onClose={() => setAddLayerOpen(false)}
        onLayerCreated={(layer) => {
          setAddLayerOpen(false);
          onGenericLayerAdded?.(layer);
        }}
        project={scenarioProp?.project ?? ""}
        scenario={scenarioProp?.scenario ?? ""}
      />
    </Wrapper>
  );
}
