import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/ui.css';
import './styles/auth.css';
import './styles/pages.css';
import './styles/ledger.css';
import './styles/media.css';
import './styles/version.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
