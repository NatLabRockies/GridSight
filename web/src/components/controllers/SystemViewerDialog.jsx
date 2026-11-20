import { useEffect, useMemo } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TablePagination from "@mui/material/TablePagination";
import TextField from "@mui/material/TextField";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { queryExtension } from "../../lib/loaders.js";
import { useSystemViewerState } from "../../state/systemViewerState.js";

const PAGE_SIZE = 100;

function isSimpleScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function renderCell(v) {
  if (v === null || v === undefined) return "";
  if (isSimpleScalar(v)) return String(v);
  // Nested objects/arrays — render as compact JSON. Truncate so a single
  // large nested struct doesn't blow up row height.
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

/**
 * SystemViewerDialog — inspect components inside a Sienna system.
 *
 * Lists every component type the system declares (ACBus, ThermalStandard,
 * Line, Arc, …) with row counts; selecting one paginates through its
 * rows. Rows fetched server-side via `queryExtension('gat', ...)`.
 *
 * Props:
 *   open       boolean
 *   onClose    () => void
 *   project    string
 *   scenario   string
 *   extension  { name } (defaults to "gat")
 *   initialComponent  optional component type to open with (e.g. "ACBus")
 */
export default function SystemViewerDialog({
  open,
  onClose,
  project,
  scenario,
  extension,
  initialComponent = "",
}) {
  const extName = extension?.name ?? "gat";

  const sv = useSystemViewerState(initialComponent);
  const {
    components, loadingComponents, componentsError, systemPath, systemAvailable,
    selected, page, filter,
    rows, columns, total, loadingRows, rowsError,
  } = sv.state;

  // Reset state when the dialog opens for a different scenario.
  useEffect(() => {
    if (!open) return;
    sv.patch({
      selected: initialComponent,
      page: 0,
      filter: "",
      rows: [],
      columns: [],
      total: 0,
      rowsError: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project, scenario, initialComponent]);

  // Fetch component list when opened.
  useEffect(() => {
    if (!open || !project || !scenario) return;
    let cancelled = false;
    sv.componentsStart();
    queryExtension(extName, "system_components", { project, scenario })
      .then((data) => {
        if (cancelled) return;
        sv.componentsSuccess({
          components: data?.components || [],
          systemPath: data?.system_path || "",
          systemAvailable: data?.available !== false,
        });
      })
      .catch((e) => { if (!cancelled) sv.componentsError(String(e?.message || e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project, scenario, extName]);

  // Fetch the selected component's page.
  useEffect(() => {
    if (!open || !selected || !project || !scenario) return;
    let cancelled = false;
    sv.rowsStart();
    queryExtension(extName, "system_component_rows", {
      project,
      scenario,
      component_type: selected,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
      .then((data) => {
        if (cancelled) return;
        sv.rowsSuccess({
          rows: data?.rows || [],
          columns: data?.columns || [],
          total: data?.total ?? 0,
        });
      })
      .catch((e) => { if (!cancelled) sv.rowsError(String(e?.message || e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project, scenario, extName, selected, page]);

  const filteredComponents = useMemo(() => {
    if (!filter) return components;
    const f = filter.toLowerCase();
    return components.filter((c) => c.name.toLowerCase().includes(f));
  }, [components, filter]);

  function copyJson() {
    if (!rows.length) return;
    try {
      navigator.clipboard?.writeText(JSON.stringify(rows, null, 2));
    } catch { /* noop */ }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Inspect System
        {systemPath && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", fontWeight: 400 }}>
            {systemPath}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2} sx={{ minHeight: 480 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              placeholder="Filter components…"
              value={filter}
              onChange={(e) => sv.setFilter(e.target.value)}
              sx={{ width: 220 }}
            />
            <FormControl size="small" sx={{ minWidth: 280, flex: 1 }}>
              <InputLabel>Component</InputLabel>
              <Select
                value={selected}
                label="Component"
                onChange={(e) => sv.setSelected(e.target.value)}
                disabled={loadingComponents}
              >
                {filteredComponents.length === 0 && (
                  <MenuItem value="" disabled>
                    {loadingComponents ? "Loading…" : "No matching components"}
                  </MenuItem>
                )}
                {filteredComponents.map((c) => (
                  <MenuItem key={c.name} value={c.name}>
                    {c.name}{" "}
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      ({c.count})
                    </Typography>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Copy current page rows as JSON">
              <span>
                <IconButton size="small" onClick={copyJson} disabled={!rows.length}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          {!loadingComponents && !systemAvailable && (
            <Alert severity="info" variant="outlined">
              No Sienna system found for {project || "—"}/{scenario || "—"}.
              Make sure a GAT scenario is selected, or create one via "Create Scenario".
            </Alert>
          )}
          {componentsError && <Alert severity="error" variant="outlined">{componentsError}</Alert>}
          {rowsError && <Alert severity="error" variant="outlined">{rowsError}</Alert>}

          {loadingRows && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress />
            </Box>
          )}

          {!loadingRows && selected && rows.length > 0 && (
            <>
              <Box sx={{ overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {columns.map((c) => (
                        <TableCell key={c} sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>{c}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((r, i) => (
                      <TableRow key={i} hover>
                        {columns.map((c) => (
                          <TableCell key={c} sx={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>
                            {renderCell(r[c])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
              <TablePagination
                component="div"
                count={total}
                page={page}
                rowsPerPage={PAGE_SIZE}
                rowsPerPageOptions={[PAGE_SIZE]}
                onPageChange={(_e, p) => sv.setPage(p)}
              />
            </>
          )}

          {!loadingRows && selected && rows.length === 0 && !rowsError && (
            <Typography variant="body2" color="text.secondary">
              No rows returned for {selected}.
            </Typography>
          )}

          {!selected && !loadingComponents && !componentsError && (
            <Typography variant="body2" color="text.secondary">
              Pick a component above to view its rows.
              {components.length > 0 && ` (${components.length} types available)`}
            </Typography>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
