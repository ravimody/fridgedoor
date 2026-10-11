import {applyAppearance,readAppearance} from './app/appearance.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App.js';
import './app/styles.css';

applyAppearance(readAppearance());
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter basename="/dashboard/"><App /></BrowserRouter></QueryClientProvider></React.StrictMode>);
