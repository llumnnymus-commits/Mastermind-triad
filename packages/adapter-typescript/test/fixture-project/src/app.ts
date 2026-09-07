import { serve } from './service.js';
import { z } from 'zod';
export const app = () => serve() + String(z);
