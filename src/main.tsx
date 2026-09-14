import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, readTheme } from './theme';
import { ExecutionSettingsProvider } from './workflow/ExecutionSettings';
applyTheme(readTheme());
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ExecutionSettingsProvider><App /></ExecutionSettingsProvider></React.StrictMode>);
