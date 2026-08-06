import { redirect } from '../../../lib/http.js';
import { clearSessionCookie } from '../../../lib/auth.js';

export const onRequestPost = () => redirect('/', { 'set-cookie': clearSessionCookie() });
export const onRequestGet = onRequestPost;
