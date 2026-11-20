import React, { createContext, useContext, useState, useMemo, useCallback, useEffect } from 'react';
import { ThemeProvider as MuiThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { THEMES, DEFAULT_THEME, THEME_NAMES } from './themes.js';
import { FONT_IDS, DEFAULT_FONT, fontStack } from './fonts.js';

const STORAGE_KEY = 'meridian-theme';
const FONT_STORAGE_KEY = 'meridian-font';

function loadSavedTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEME_NAMES.includes(saved)) return saved;
  } catch {}
  return DEFAULT_THEME;
}

function loadSavedFont() {
  try {
    const saved = localStorage.getItem(FONT_STORAGE_KEY);
    if (saved && FONT_IDS.includes(saved)) return saved;
  } catch {}
  return DEFAULT_FONT;
}

const ThemeContext = createContext({
  themeName: DEFAULT_THEME,
  setThemeName: () => {},
  fontName: DEFAULT_FONT,
  setFontName: () => {},
});

export function useMeridianTheme() {
  return useContext(ThemeContext);
}

export function MeridianThemeProvider({ children }) {
  const [themeName, setThemeNameRaw] = useState(loadSavedTheme);
  const [fontName, setFontNameRaw] = useState(loadSavedFont);

  const setThemeName = useCallback((name) => {
    if (!THEME_NAMES.includes(name)) return;
    setThemeNameRaw(name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  }, []);

  const setFontName = useCallback((name) => {
    if (!FONT_IDS.includes(name)) return;
    setFontNameRaw(name);
    try { localStorage.setItem(FONT_STORAGE_KEY, name); } catch {}
  }, []);

  // Overlay the chosen family onto the theme. The base themes set no
  // `typography.fontFamily`, so MUI would otherwise fall back to its built-in
  // Roboto stack — and Roboto is NOT bundled, leaving components on
  // Helvetica/Arial while the document body used the system stack from
  // globals.css. Setting it here keeps MUI and the body in agreement.
  const theme = useMemo(() => {
    const base = THEMES[themeName] ?? THEMES[DEFAULT_THEME];
    const stack = fontStack(fontName);
    // Setting `typography.fontFamily` alone is NOT enough: createTheme has
    // already run createTypography on the base theme, which copies the family
    // into every resolved variant (h1…h6, body1/2, button, caption, …). MUI
    // styles most surfaces from those variants — CssBaseline draws <body> from
    // typography.body1 — so a top-level-only override leaves everything on
    // MUI's default Roboto stack. Restamp each variant that carries a family.
    const typography = { fontFamily: stack };
    for (const [key, value] of Object.entries(base.typography ?? {})) {
      if (value && typeof value === 'object' && 'fontFamily' in value) {
        typography[key] = { fontFamily: stack };
      }
    }
    return createTheme(base, { typography });
  }, [themeName, fontName]);

  // Publish the stack as a CSS variable so plain-CSS surfaces (globals.css) and
  // any non-MUI canvas/chart code can follow the same choice.
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font', fontStack(fontName));
  }, [fontName]);

  const ctx = useMemo(
    () => ({ themeName, setThemeName, fontName, setFontName }),
    [themeName, setThemeName, fontName, setFontName],
  );

  return (
    <ThemeContext.Provider value={ctx}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}
