'use strict';
// Instance ids from the SYSTEMS desk. The original of a family keeps the family
// name (`rs6`, `e2`, `atem`, …). A copy is that name plus a short suffix
// (`rs6-k3f2a1`). A stored family name still means the original instance.

const INST_RE = /^(rs6|e2|pixelhue|atem|ptz|pixera|millumin|videohub|hyperdeck|mitti)(-[a-z0-9]{4,12})?$/;
const HIRES_RE = /^(rs6|e2|pixelhue)(-[a-z0-9]{4,12})?$/;
const LOOK_RE = /^(rs6|e2|pixelhue|atem)(-[a-z0-9]{4,12})?$/;

function familyOf(id) {
  const m = String(id || '').match(INST_RE);
  return m ? m[1] : '';
}
function isInstanceId(id) { return INST_RE.test(String(id || '')); }
function isHires(id) { return HIRES_RE.test(String(id || '')); }
function isLookSystem(id) { return LOOK_RE.test(String(id || '')); }
function isAddedInstance(id) {
  const s = String(id || '');
  return isInstanceId(s) && s !== familyOf(s);
}

module.exports = { INST_RE, HIRES_RE, LOOK_RE, familyOf, isInstanceId, isHires, isLookSystem, isAddedInstance };
