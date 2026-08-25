# Auth HTTP security assumptions

The MVP assumes that the frontend and API are deployed on the same site, even
when they use different origins such as `app.example.com` and
`api.example.com`. Refresh tokens use an HttpOnly, SameSite=Lax cookie scoped
to `/api/v1/auth`. Production refresh and logout requests must also carry an
Origin header that exactly matches `FRONTEND_ORIGIN`.

A future cross-site deployment would require `SameSite=None; Secure` and an
additional CSRF token mechanism. CORS is restricted to `FRONTEND_ORIGIN`, but
CORS alone is not treated as CSRF protection.
