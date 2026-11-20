import React from "react";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import PaletteIcon from "@mui/icons-material/Palette";
import HubIcon from "@mui/icons-material/Hub";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import ApiOutlinedIcon from "@mui/icons-material/ApiOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import { isTauri } from "../../../lib/desktopBridge.js";

const ITEMS = [
  { key: "display",          Icon: TuneOutlinedIcon,      label: "Display"           },
  { key: "extensions",       Icon: ExtensionOutlinedIcon, label: "Extensions"        },
  { key: "agentIntegration", Icon: ApiOutlinedIcon,       label: "Agent Integration", tauriOnly: true },
  { key: "developer",        Icon: CodeOutlinedIcon,      label: "Developer"         },
];

/**
 * Sidebar "Tools" list — Color Palettes, Graph view, and per-section
 * settings buttons (Display, Extensions, Agent Integration, Developer).
 */
export default function SidebarToolsList({
  showLabels,
  colorPanelOpen,
  onColorPaletteClick,
  onGraphClick,
  openKey,
  onSettingsSectionClick,
}) {
  const tauri = isTauri();

  return (
    <>
      <Divider />
      {showLabels && (
        <Typography variant="overline" color="text.secondary" sx={{ px: 2, pt: 1, display: "block", lineHeight: 1.5 }}>
          Tools
        </Typography>
      )}
      <List>
        <ListItem disablePadding>
          <ListItemButton onClick={onColorPaletteClick}>
            <ListItemIcon sx={{ minWidth: showLabels ? 56 : "auto", opacity: colorPanelOpen ? 1 : 0.5 }}>
              <PaletteIcon />
            </ListItemIcon>
            {showLabels && <ListItemText primary="Color Palettes" />}
          </ListItemButton>
        </ListItem>

        {onGraphClick && (
          <ListItem disablePadding>
            <ListItemButton onClick={onGraphClick}>
              <ListItemIcon sx={{ minWidth: showLabels ? 56 : "auto" }}><HubIcon /></ListItemIcon>
              {showLabels && <ListItemText primary="Graph View" />}
            </ListItemButton>
          </ListItem>
        )}

        <Divider />
        {showLabels && (
          <Typography variant="overline" color="text.secondary" sx={{ px: 2, pt: 1, display: "block", lineHeight: 1.5 }}>
            Settings
          </Typography>
        )}

        {ITEMS.map(({ key, Icon, label, tauriOnly }) => {
          if (tauriOnly && !tauri) return null;
          const active = openKey === key;
          return (
            <ListItem key={key} disablePadding>
              <ListItemButton onClick={(e) => onSettingsSectionClick(key, e)}>
                <ListItemIcon sx={{ minWidth: showLabels ? 56 : "auto", opacity: active ? 1 : 0.5 }}>
                  <Icon />
                </ListItemIcon>
                {showLabels && <ListItemText primary={label} />}
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </>
  );
}
