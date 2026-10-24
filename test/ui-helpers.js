'use strict';
// 0.11.0 two-row navigation: a page tab is only shown while its system group is selected in the top row.
// openTab() clicks the group button first when needed, then the page tab, like an operator would.
async function openTab(page, tab) {
  const sel = `.tab[data-tab="${tab}"]`;
  if (tab !== 'system') {
    const grp = await page.getAttribute(sel, 'data-sys', { timeout: 15000 });
    if (grp && !(await page.locator(sel).isVisible())) await page.click(`.tgrp[data-tabgrp="${grp}"]`);
  }
  await page.click(sel);
}
module.exports = { openTab };
