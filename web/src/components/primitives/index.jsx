/**
 * primitives — small, project-wide presentational components.
 *
 * What belongs here: components that are reused (or expected to be reused
 * imminently) across multiple files and have no domain logic — pure
 * styling/layout shells. The goal is to keep the visual vocabulary
 * consistent without forcing every caller to reach for raw MUI sx props.
 *
 * What does NOT belong: anything tied to a specific feature (a chart
 * frame, a layer styler, a map controller). Domain components stay in
 * `components/<feature>/`.
 *
 * Migration policy: don't bulk-rewrite existing inline sx callsites to
 * use these. When you touch a file for another reason, swap inline
 * patterns for primitives if a match exists. The first goal is to set
 * the convention; mass migration is a separate task.
 */

import Box from '@mui/material/Box';
import Icon from '@mui/material/Icon';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

/**
 * Compact inline help icon. Renders nothing when `tip` is empty so callers
 * can pass a per-field tooltip lookup without conditional wrapping.
 */
export function InfoTip({ tip, placement = 'top' }) {
  if (!tip) return null;
  return (
    <Tooltip title={tip} placement={placement} arrow>
      <InfoOutlinedIcon
        sx={{ fontSize: 14, color: 'text.disabled', ml: 0.5, cursor: 'help' }}
      />
    </Tooltip>
  );
}

/**
 * Drawer/list icon for an extension entry. Resolves three cases:
 *   - `ext.icon` is a URL (server-served SVG asset) → render as a CSS
 *     mask filled with `currentColor`, so the icon inherits the theme's
 *     text color and follows light/dark mode. The raw `<img>` rendering
 *     ignores any `currentColor` references inside the SVG (the image
 *     loads in its own document context where `color` defaults to
 *     black), which is why a mask is needed.
 *   - `ext.icon` is a Material icon name (e.g. 'bolt') → render via
 *     MUI's `<Icon>` font, which already honors theme color.
 *   - `ext.icon` is empty → render the generic Extension glyph.
 *
 * Sizing follows MUI's `Icon.fontSize` semantics: 'small' (18px),
 * 'medium' (24px), or a number / theme-spacing string for custom sizes.
 */
export function ExtensionIcon({ ext, fontSize = 'medium', sx, color }) {
  const px = fontSize === 'small' ? 18 : fontSize === 'large' ? 36 : 24;
  if (!ext?.icon) {
    return <ExtensionOutlinedIcon fontSize={fontSize} color={color} sx={sx} />;
  }
  // A URL if it starts with '/' (relative) or contains a scheme delimiter
  // (`http://`, `https://`, `meridian-api://`, `data:`, etc.). Anything
  // else is treated as a Material icon name.
  const isUrl = ext.icon.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(ext.icon);
  if (!isUrl) {
    return <Icon fontSize={fontSize} color={color} sx={sx}>{ext.icon}</Icon>;
  }
  return (
    <Box
      sx={{
        width: px,
        height: px,
        bgcolor: 'currentColor',
        maskImage: `url(${ext.icon})`,
        WebkitMaskImage: `url(${ext.icon})`,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        ...sx,
      }}
      role="img"
      aria-hidden
    />
  );
}

/**
 * Banner-style section header used to break up dense control panels into
 * visual groups. Sits inside its own row with the primary contrast color
 * so a section break is impossible to miss.
 */
export function SectionHeader({ children }) {
  return (
    <Typography
      variant="subtitle2"
      align="center"
      bgcolor="primary.main"
      color="primary.contrastText"
      sx={{ borderRadius: 1, px: 1, py: 0.25, mb: 1, mt: 1 }}
    >
      {children}
    </Typography>
  );
}
