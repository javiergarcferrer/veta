# veta — retired

This repo held a from-scratch rewrite of the Alcover configurator. It was a
mistake: the real configurator already exists in the RosetSoft app, refined
over months, and it is the one that ships to dealers. A second implementation
could only ever be a worse copy of it, and was.

**The configurator lives in RosetSoft** (`src/pages/embed/TogoEmbed.jsx`),
served per dealer from the Distribuidores workspace:

    https://<app-origin>/configurator?dealer=<slug>

Multi-dealer support lives there too — `public.dealers` (catalog scope,
currency + FX, markup, pricing mode, lead inbox), the `togo-embed` edge
function, and the Distribuidores back-office.

The only thing from this repo still in use is the additive `veta` schema in
the Supabase project (`infra/supabase/shared/`), kept because it is deployed;
it is not required by anything in RosetSoft.
