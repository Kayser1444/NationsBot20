export function dashboardTheme(html, environmentName) {
  if (environmentName?.trim().toLowerCase() !== 'staging') return html;
  const style = `
:root[data-environment=staging]{background:#f6f0fc}
[data-environment=staging] body{border-top:6px solid #7438a8}
[data-environment=staging] .card,[data-environment=staging] .panel{border-color:#d9c4eb}
[data-environment=staging] button:not(.remove):not(.user-link){background:#7438a8}
[data-environment=staging] a,[data-environment=staging] .user-link{color:#7438a8}
.environment-banner{position:sticky;top:0;z-index:10;display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;margin-bottom:24px;padding:14px 18px;border:1px solid #7438a8;border-radius:10px;background:#7438a8;color:white;box-shadow:0 4px 14px #46226320}
.environment-banner strong{letter-spacing:1px}.environment-banner span{font-size:14px}
`;
  return html.replace('<html lang="sv">', '<html lang="sv" data-environment="staging">')
    .replace('<title>', '<title>STAGING · ')
    .replace('</style>', style + '</style>')
    .replace('<main>', '<main><aside class="environment-banner" aria-label="Miljö"><strong>STAGING · TESTMILJÖ</strong><span>Du arbetar i testmiljön.</span></aside>');
}
