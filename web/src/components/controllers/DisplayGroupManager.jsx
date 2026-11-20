/**
 * DisplayGroupManager — manages GAT entity → display-group overrides.
 *
 * Three tabs: Categories, Entities, Import/Export YAML. A scope toggle
 * (Project / Scenario) at the top of the dialog gates writes on the
 * Entities and Import/Export tabs; the Categories tab is always
 * project-scoped because categories are project-wide by design.
 *
 * Backend lives in the GAT extension repo at
 * gridsight-ext/src/gridsight_gat/display_groups.py — every action here
 * maps to a `query_extension` call with one of the 11 supported `kind`s.
 *
 * Writes return an `invalidated` hint that we surface via the parent
 * `onInvalidated` callback so the rest of GridSight re-fetches chart
 * specs (categories may have new colors).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UndoIcon from '@mui/icons-material/Undo';
import AddIcon from '@mui/icons-material/Add';
import { queryExtension, invalidateCache, invalidateCachePrefix } from '../../lib/loaders.js';
import { useAlert, useConfirm, usePrompt } from '../../lib/dialogs.jsx';

const EXT = 'gat';

// A Sienna scenario can have many thousands of components. Mounting a
// full MUI <Select> per row at that scale freezes the WebView (~5k
// rows = 50k+ DOM nodes). Cap visible rows; filter narrows the user's
// view to the entities they actually want to touch.
const MAX_VISIBLE_ENTITY_ROWS = 200;

// Stable, name-derived swatch fallback. Used when the backend reports an
// auto category that doesn't map to one of GAT's canonical palette entries
// AND the user hasn't picked a colour for it yet — without this we'd show
// every such category as grey, which makes the Categories tab look broken
// on a freshly-loaded project.
function fallbackColor(name) {
  if (!name) return '#808080';
  let h = 5381;
  for (let i = 0; i < name.length; i += 1) {
    h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  }
  return '#' + (h & 0xffffff).toString(16).padStart(6, '0');
}

// ── Loader wrappers ────────────────────────────────────────────────────────

async function dgQuery(kind, params) {
  const r = await queryExtension(EXT, kind, params);
  if (r?.ok === false) throw new Error(r.error || `${kind} failed`);
  return r;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function DisplayGroupManager({
  open, onClose, project, scenario, onInvalidated,
}) {
  const [tab, setTab] = useState('categories');
  const [scope, setScope] = useState('project');
  const [categories, setCategories] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filterText, setFilterText] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const alert = useAlert();
  const confirm = useConfirm();
  const prompt = usePrompt();

  // Categories always loads (cheap — usually under a hundred rows).
  // Entities is deferred: it can be thousands of rows on a Sienna scenario
  // and we shouldn't fetch + render until the user actually opens that
  // tab. Cleared back to [] when the dialog closes or the scenario
  // changes so the stale list doesn't flash on next open.
  const refreshCategories = useCallback(async () => {
    if (!open || !project || !scenario) return;
    try {
      const cRes = await dgQuery('list_categories', { project, scenario });
      setCategories(cRes.categories || []);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, [open, project, scenario]);

  const refreshEntities = useCallback(async () => {
    if (!open || !project || !scenario) return;
    setLoading(true); setError(null);
    try {
      const eRes = await dgQuery('list_entities', { project, scenario });
      setEntities(eRes.entities || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [open, project, scenario]);

  // First open + category-tab refreshes only reload the cheap categories
  // list. Entities loads on demand the first time the user clicks into
  // the Entities tab (or after a write that affects entity mappings).
  useEffect(() => {
    if (!open) { setEntities([]); return; }
    refreshCategories();
  }, [open, refreshCategories]);

  useEffect(() => {
    if (tab === 'entities' && open && entities.length === 0 && !loading) {
      refreshEntities();
    }
  }, [tab, open, entities.length, loading, refreshEntities]);

  const refresh = useCallback(async () => {
    // Used by afterWrite — refetch whichever tab is active so the user
    // sees the result of their edit without paying for both.
    await refreshCategories();
    if (tab === 'entities') await refreshEntities();
  }, [refreshCategories, refreshEntities, tab]);

  // Bump the parent's refresh-key after any write AND invalidate the
  // cached chart-spec list + chart-data so the System Generation Stack
  // and any other GAT scenario chart re-renders with the new colours /
  // category assignments. `fetchExtensionCharts` and `fetchChartData`
  // both go through `cachedRequest` (loaders.js), so without the
  // invalidate the dialog could fire 100 colour changes and the chart
  // frame would still serve the original cached spec list.
  const afterWrite = useCallback((result) => {
    invalidateCache(`ext-charts:${EXT}`);
    invalidateCachePrefix('chart-data:');
    refresh();
    if (Array.isArray(result?.invalidated) && result.invalidated.length) {
      onInvalidated?.(result.invalidated);
    }
  }, [refresh, onInvalidated]);

  // Pre-compute category name → row for swatch lookups in the Entities tab.
  const categoriesByName = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.name, c])),
    [categories],
  );

  return (
    <Dialog open={!!open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <span>Display Groups</span>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {project} / {scenario}
        </Typography>
      </DialogTitle>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', px: 2 }}>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ flex: 1 }}>
          <Tab value="categories" label="Categories" />
          <Tab value="entities"   label="Entities" />
          <Tab value="io"         label="Import / Export YAML" />
        </Tabs>
        {/* The Categories tab is intrinsically project-scoped — the
            toggle would mean nothing there, so we hide it. */}
        {tab !== 'categories' && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_e, v) => v && setScope(v)}
            sx={{ ml: 2 }}
          >
            <ToggleButton value="project">Project</ToggleButton>
            <ToggleButton value="scenario">Scenario</ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>
      <DialogContent sx={{ minHeight: 480, position: 'relative' }}>
        {loading && (
          <Box sx={{ position: 'absolute', top: 16, right: 16 }}>
            <CircularProgress size={16} />
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        )}
        {tab === 'categories' && (
          <CategoriesTab
            project={project}
            categories={categories}
            setCategories={setCategories}
            afterWrite={afterWrite}
            alert={alert}
            confirm={confirm}
            prompt={prompt}
          />
        )}
        {tab === 'entities' && (
          <EntitiesTab
            project={project}
            scenario={scenario}
            scope={scope}
            categories={categories}
            categoriesByName={categoriesByName}
            entities={entities}
            filterText={filterText}
            setFilterText={setFilterText}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            afterWrite={afterWrite}
            alert={alert}
          />
        )}
        {tab === 'io' && (
          <ImportExportTab
            project={project}
            scenario={scenario}
            scope={scope}
            afterWrite={afterWrite}
            alert={alert}
            confirm={confirm}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Categories tab ─────────────────────────────────────────────────────────

function CategoriesTab({ project, categories, setCategories, afterWrite, alert, confirm, prompt }) {
  // Track the pending colour write per category so a fast user dragging
  // through the swatch only triggers one network call. Without this each
  // pixel of slider movement would POST.
  const pendingTimers = useRef({});
  return (
    <Box>
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ flex: 1 }} color="text.secondary">
          Project-scoped. Color and order apply across every scenario in this project.
        </Typography>
        <NewCategoryButton project={project} afterWrite={afterWrite} prompt={prompt} alert={alert} />
      </Stack>
      <Box
        sx={{
          maxHeight: 380, overflowY: 'auto',
          border: 1, borderColor: 'divider', borderRadius: 1,
        }}
      >
        {categories.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ p: 2, display: 'block' }}>
            No categories yet. Click + to create one.
          </Typography>
        )}
        {categories.map((c) => (
          <Stack
            key={c.name}
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}
          >
            <input
              type="color"
              value={c.color_hex || fallbackColor(c.name)}
              onChange={(e) => {
                const next = e.target.value;
                // 1. Optimistic local update — swatch + any preview in
                //    the dialog reflect the new colour immediately.
                setCategories((prev) =>
                  prev.map((cc) => (cc.name === c.name
                    ? { ...cc, color_hex: next, source: 'user' }
                    : cc)),
                );
                // 2. Debounce the network write — `input[type=color]`
                //    fires onChange on every micro-adjustment, so without
                //    coalescing we'd flood the sidecar.
                const existing = pendingTimers.current[c.name];
                if (existing) clearTimeout(existing);
                pendingTimers.current[c.name] = setTimeout(async () => {
                  delete pendingTimers.current[c.name];
                  try {
                    const res = await dgQuery('set_category_color', {
                      project, category: c.name, color_hex: next,
                    });
                    afterWrite(res);
                  } catch (err) {
                    await alert({ title: 'Set color failed', message: err.message });
                  }
                }, 250);
              }}
              style={{ width: 32, height: 24, border: 'none', cursor: 'pointer', borderRadius: 4 }}
            />
            <Typography variant="body2" sx={{ flex: 1 }}>{c.name}</Typography>
            <Chip
              size="small"
              label={c.source === 'user' ? 'user' : 'auto'}
              color={c.source === 'user' ? 'primary' : 'default'}
              variant={c.source === 'user' ? 'filled' : 'outlined'}
            />
            <IconButton
              size="small"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete "${c.name}"?`,
                  message: 'Allowed only when no entity overrides reference it.',
                  confirmText: 'Delete',
                  destructive: true,
                });
                if (!ok) return;
                try {
                  const res = await dgQuery('delete_category', { project, category: c.name });
                  afterWrite(res);
                } catch (err) {
                  await alert({ title: 'Delete failed', message: err.message });
                }
              }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Stack>
        ))}
      </Box>
    </Box>
  );
}

function NewCategoryButton({ project, afterWrite, prompt, alert }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="small"
      variant="outlined"
      startIcon={<AddIcon />}
      disabled={busy}
      onClick={async () => {
        const name = await prompt({
          title: 'New category',
          label: 'Category name',
          confirmText: 'Create',
        });
        if (!name) return;
        // Hash-derived default colour — matches fallbackColor() so the
        // swatch on the row is the same shade the rest of the panel
        // shows for a category with no explicit colour yet.
        const hex = fallbackColor(name);
        setBusy(true);
        try {
          const res = await dgQuery('create_category', {
            project, name, color_hex: hex,
          });
          afterWrite(res);
        } catch (e) {
          await alert({ title: 'Create failed', message: e.message });
        } finally {
          setBusy(false);
        }
      }}
    >
      New category
    </Button>
  );
}

// ── Entities tab ───────────────────────────────────────────────────────────

function EntitiesTab({
  project, scenario, scope, categories, categoriesByName, entities,
  filterText, setFilterText, filterCategory, setFilterCategory,
  afterWrite, alert,
}) {
  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return entities.filter((e) => {
      if (filterCategory && e.current_category !== filterCategory) return false;
      if (!needle) return true;
      return (
        (e.entity_id || '').toLowerCase().includes(needle)
        || (e.prime_mover || '').toLowerCase().includes(needle)
        || (e.fuel || '').toLowerCase().includes(needle)
      );
    });
  }, [entities, filterText, filterCategory]);

  return (
    <Box>
      {/* Bulk widget — always visible at the top so users notice they
          can paste/upload rather than click rows one by one. */}
      <BulkOverridePanel
        project={project}
        scenario={scenario}
        scope={scope}
        categories={categories}
        afterWrite={afterWrite}
        alert={alert}
      />

      {/* Filter row */}
      <Stack direction="row" spacing={1} sx={{ mt: 2, mb: 1 }}>
        <TextField
          size="small"
          placeholder="Filter by entity id / prime mover / fuel"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Select
          size="small"
          displayEmpty
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value=""><em>Any category</em></MenuItem>
          {categories.map((c) => (
            <MenuItem key={c.name} value={c.name}>{c.name}</MenuItem>
          ))}
        </Select>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        {filtered.length} / {entities.length} entities · writes go to <b>{scope}</b> level
        {filtered.length > MAX_VISIBLE_ENTITY_ROWS && (
          <> · showing first {MAX_VISIBLE_ENTITY_ROWS} — narrow with the filter to see others</>
        )}
      </Typography>

      <Box sx={{ maxHeight: 360, overflowY: 'auto', mt: 0.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
        {/* Slice on render. Mounting a full MUI <Select> per row is
            expensive at scale (a 5000-entity Sienna scenario freezes
            the WebView for several seconds), and we don't render
            anything the user can't see anyway. */}
        {filtered.slice(0, MAX_VISIBLE_ENTITY_ROWS).map((row) => (
          <EntityRow
            key={row.entity_id}
            row={row}
            scope={scope}
            project={project}
            scenario={scenario}
            categories={categories}
            categoriesByName={categoriesByName}
            afterWrite={afterWrite}
            alert={alert}
          />
        ))}
      </Box>
    </Box>
  );
}

function EntityRow({ row, scope, project, scenario, categories, categoriesByName, afterWrite, alert }) {
  const swatch = categoriesByName[row.current_category]?.color_hex
    || fallbackColor(row.current_category);
  const overrideForScope = scope === 'project' ? row.project_override : row.scenario_override;
  return (
    <Stack
      direction="row" alignItems="center" spacing={1}
      sx={{ px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider' }}
    >
      <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: swatch, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>{row.entity_id}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          base: {row.base_category}
          {row.prime_mover ? ` · pm=${row.prime_mover}` : ''}
          {row.fuel ? ` · fuel=${row.fuel}` : ''}
        </Typography>
      </Box>
      {row.project_override && (
        <Chip
          size="small"
          label={`P: ${row.project_override}`}
          color={scope === 'project' ? 'primary' : 'default'}
          variant="outlined"
        />
      )}
      {row.scenario_override && (
        <Chip
          size="small"
          label={`S: ${row.scenario_override}`}
          color={scope === 'scenario' ? 'primary' : 'default'}
          variant="outlined"
        />
      )}
      <Select
        size="small"
        value={row.current_category}
        onChange={async (e) => {
          try {
            const res = await dgQuery('set_category_override', {
              project, scenario, scope,
              entity_id: row.entity_id, category: e.target.value,
            });
            afterWrite(res);
          } catch (err) {
            await alert({ title: 'Reassign failed', message: err.message });
          }
        }}
        sx={{ minWidth: 140 }}
      >
        {categories.map((c) => (
          <MenuItem key={c.name} value={c.name}>{c.name}</MenuItem>
        ))}
      </Select>
      {overrideForScope && (
        <IconButton
          size="small"
          title={`Clear ${scope}-level override`}
          onClick={async () => {
            try {
              const res = await dgQuery('clear_category_override', {
                project, scenario, scope, entity_id: row.entity_id,
              });
              afterWrite(res);
            } catch (err) {
              await alert({ title: 'Revert failed', message: err.message });
            }
          }}
        >
          <UndoIcon fontSize="small" />
        </IconButton>
      )}
    </Stack>
  );
}

function BulkOverridePanel({ project, scenario, scope, categories, afterWrite, alert }) {
  const [paste, setPaste] = useState('');
  const [targetCategory, setTargetCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const applyPaste = async () => {
    const ids = paste.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      await alert({ title: 'No entities', message: 'Paste at least one entity id.' });
      return;
    }
    if (!targetCategory) {
      await alert({ title: 'No category', message: 'Pick a target category.' });
      return;
    }
    setBusy(true);
    try {
      const res = await dgQuery('bulk_set_overrides', {
        project, scenario, scope,
        items: ids.map((eid) => ({ entity_id: eid, category: targetCategory })),
      });
      afterWrite(res);
      const skipped = (res.skipped || []).length;
      const msg = `${res.applied} applied${skipped ? `, ${skipped} skipped` : ''}.`;
      await alert({ title: 'Bulk override done', message: msg });
      setPaste('');
    } catch (e) {
      await alert({ title: 'Bulk override failed', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const applyCsv = async (file) => {
    if (!file) return;
    const csv_text = await file.text();
    setBusy(true);
    try {
      const res = await dgQuery('import_overrides_csv', {
        project, scenario, scope, csv_text,
        default_category: targetCategory || undefined,
      });
      afterWrite(res);
      const skipped = (res.skipped || []).length;
      await alert({
        title: 'CSV import done',
        message: `${res.applied} applied${skipped ? `, ${skipped} skipped` : ''}.`,
      });
    } catch (e) {
      await alert({ title: 'CSV import failed', message: e.message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover' }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Bulk reassign</Typography>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          multiline
          minRows={3}
          maxRows={6}
          placeholder={'One entity_id per line (or comma-separated)'}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Stack spacing={1} sx={{ minWidth: 200 }}>
          <Select
            size="small"
            displayEmpty
            value={targetCategory}
            onChange={(e) => setTargetCategory(e.target.value)}
          >
            <MenuItem value=""><em>Pick target category</em></MenuItem>
            {categories.map((c) => (
              <MenuItem key={c.name} value={c.name}>{c.name}</MenuItem>
            ))}
          </Select>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={applyPaste}
          >
            Apply paste
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Upload CSV…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => applyCsv(e.target.files?.[0])}
          />
        </Stack>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        CSV accepts a single column (entity_id, uses the picked category) or two columns
        (entity_id, category). Writes go to the <b>{scope}</b> level.
      </Typography>
    </Box>
  );
}

// ── Import / Export tab ────────────────────────────────────────────────────

function ImportExportTab({ project, scenario, scope, afterWrite, alert, confirm }) {
  const [yamlText, setYamlText] = useState('');
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  // Preview holds the exported YAML so the user always has a working
  // copy path — Tauri WebView intermittently swallows synthetic
  // anchor-click downloads, so a visible textarea with a "Copy" button
  // is the only reliable cross-shell delivery.
  const [preview, setPreview] = useState(null); // {files: {name: yaml}, scope}

  const doImport = async () => {
    const ok = await confirm({
      title: 'Import overrides?',
      message: `This may overwrite existing ${scope}-level overrides and create new categories.`,
      confirmText: 'Import',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await dgQuery('import_overrides_yaml', {
        project, scenario, scope, yaml_text: yamlText,
      });
      afterWrite(res);
      const created = (res.categories_created || []).length;
      const skipped = (res.skipped || []).length;
      await alert({
        title: 'Import complete',
        message: `${res.applied} overrides, ${created} new categories${skipped ? `, ${skipped} skipped` : ''}.`,
      });
      setYamlText('');
    } catch (e) {
      await alert({ title: 'Import failed', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const res = await dgQuery('export_overrides_yaml', { project, scope });
      const files = scope === 'project'
        ? { [(res.filename || `${project}-gat-overrides.yaml`)]: (res.yaml || '') }
        : Object.fromEntries(
            Object.entries(res.files || {})
              .map(([name, text]) => [`${project}-${name}-gat-overrides.yaml`, text]),
          );
      const populated = Object.entries(files).filter(([, text]) => (text || '').trim());
      if (!populated.length) {
        await alert({ title: 'Nothing to export', message: `No ${scope}-level overrides found.` });
        return;
      }
      setPreview({ scope, files: Object.fromEntries(populated) });
    } catch (e) {
      await alert({ title: 'Export failed', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Import YAML</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Paste or upload a YAML block matching the
          <code> entity_category_overrides:</code> / <code>category_definitions:</code> schema.
          Writes to <b>{scope}</b> level (scenario imports require the active scenario).
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField
            multiline
            minRows={6}
            maxRows={14}
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            placeholder={'entity_category_overrides:\n  display_group:\n    gen_a: H2-Gas\n    gen_b: H2-Gas\ncategory_definitions:\n  H2-Gas:\n    display_color: "#E91E63"\n    display_order: 6\n'}
            sx={{ flex: 1, fontFamily: 'monospace' }}
          />
          <Stack spacing={1}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              Load file…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml,text/yaml"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setYamlText(await f.text());
                if (fileRef.current) fileRef.current.value = '';
              }}
            />
            <Button
              size="small"
              variant="contained"
              onClick={doImport}
              disabled={busy || !yamlText.trim()}
            >
              Import
            </Button>
          </Stack>
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Export YAML</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Exports the current <b>{scope}</b>-level overrides
          {scope === 'project' ? ' (one file, includes category_definitions)'
                              : ' (one file per scenario that has overrides)'}
          {' '}for review, copy, or download.
        </Typography>
        <Button variant="outlined" onClick={doExport} disabled={busy}>
          Export {scope} YAML
        </Button>
      </Box>

      <ExportPreviewDialog
        open={!!preview}
        onClose={() => setPreview(null)}
        files={preview?.files || {}}
        alert={alert}
      />
    </Stack>
  );
}

function ExportPreviewDialog({ open, onClose, files, alert }) {
  const names = Object.keys(files);
  const [active, setActive] = useState(names[0] || '');
  // Reset the active tab whenever a fresh export lands.
  useEffect(() => {
    setActive(names[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(files).join('|')]);

  if (!open) return null;
  const text = files[active] || '';

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        await alert({ title: 'Copied', message: `${active} contents copied to clipboard.` });
        return;
      }
    } catch { /* fall through to selection-copy */ }
    // Fallback: focus + select the textarea so the user can Cmd+C.
    const ta = document.getElementById('dg-export-textarea');
    if (ta) { ta.focus(); ta.select(); }
    await alert({
      title: 'Clipboard unavailable',
      message: 'Select the YAML and press Cmd+C / Ctrl+C to copy.',
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Export preview</DialogTitle>
      {names.length > 1 && (
        <Tabs
          value={active}
          onChange={(_e, v) => setActive(v)}
          sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}
          variant="scrollable"
        >
          {names.map((n) => <Tab key={n} value={n} label={n} />)}
        </Tabs>
      )}
      <DialogContent>
        <TextField
          id="dg-export-textarea"
          multiline
          minRows={12}
          maxRows={22}
          fullWidth
          value={text}
          InputProps={{ readOnly: true, style: { fontFamily: 'monospace', fontSize: 12 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={copy}>Copy to clipboard</Button>
        <Button onClick={() => downloadText(text, active)}>Download</Button>
        <Button variant="contained" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/x-yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // rel + target hint to Tauri's WebView that this should be handled
  // as a download rather than a navigation. Even in browsers that
  // ignore them they're harmless.
  a.rel = 'noopener';
  a.target = '_self';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer the revoke — some browsers (and Tauri's WKWebView in
  // particular) start the actual write asynchronously, and revoking
  // immediately can race the write and corrupt the file.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
