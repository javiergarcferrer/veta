/**
 * LEER LA MALLA — los dos harvesters de geometría que alimentan a
 * `classifyPartGroups`, en un módulo propio porque ahora tienen TRES llamadores
 * y no pueden discrepar: «Detectar partes» sobre un modelo suelto (ModelStudio),
 * el autocompletado de una importación entera (autoImport.js) y cualquier
 * futuro tagger.
 *
 * Escritos dos veces, un tagger y un lote acaban agrupando la misma malla de
 * formas distintas — y entonces la parte que el dueño confirmó a mano deja de
 * casar con la que el lote propone, que es exactamente el error que
 * `partBinding` tuvo que aprender a atrapar.
 *
 * Vive en `components/` y no en `lib/` a propósito: carga three.js y el loader
 * de mallas (IO del navegador), igual que su vecino `bindingProbe.js`. `lib/*`
 * sigue siendo Modelo puro.
 */
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { autoUnitScale } from '../../lib/configurator/model.js';
import { partKeysFor, bodySignature, accessoryRoleFor } from '../../lib/configurator/meshParts.js';
import { loadConfiguratorModels } from './modelLoader.js';

/**
 * Los GRUPOS de partes de un modelo, en cm, cada uno con su firma de
 * congruencia — exactamente lo que lee `classifyPartGroups`.
 */
export async function harvestModelGroups(mesh, upAxis) {
  const { modelFor } = await loadConfiguratorModels({ pieces: [{ mesh }] });
  const real = modelFor({ mesh });
  if (!real?.object) throw new Error('No se pudo cargar el modelo 3D.');
  const THREE = await safeDynamicImport(() => import('three'));
  const obj = real.object;
  obj.updateMatrixWorld(true);
  const zUp = (upAxis || 'y') === 'z';
  const remap = (v) => (zUp ? [v[0], v[2], v[1]] : v);
  // La caja de CADA malla primero, y las claves después: un material que tapiza
  // dos tipos de parte se parte en clusters de forma, y fusionar cajas antes de
  // ese corte promedia una losa y un rollo en una caja que no es ninguna de las
  // dos.
  const meshes = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const name = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
    const box = new THREE.Box3().setFromObject(o);
    const min = remap(box.min.toArray()), max = remap(box.max.toArray());
    meshes.push({
      materialName: name, min, max, size: max.map((v, a) => v - min[a]),
      signature: bodySignature(o.geometry?.attributes?.position?.array, o.geometry?.index?.array || null),
    });
  });
  const keys = partKeysFor(meshes);
  const byKey = new Map();
  meshes.forEach((m, i) => {
    const key = keys[i];
    const g = byKey.get(key);
    if (g) {
      g.min = g.min.map((v, a) => Math.min(v, m.min[a]));
      g.max = g.max.map((v, a) => Math.max(v, m.max[a]));
    } else byKey.set(key, { key, min: m.min, max: m.max, sig: m.signature || null });
  });
  const found = [...byKey.values()];
  if (!found.length) throw new Error('El modelo no tiene mallas.');
  const raw = found.reduce((mx, g) => Math.max(mx, ...g.max.map((v, i) => v - g.min[i])), 0);
  const unit = autoUnitScale(raw);
  return found.map((g) => ({ key: g.key, sig: g.sig, min: g.min.map((v) => v * unit), max: g.max.map((v) => v * unit) }));
}

/**
 * HUELLAS de los modelos-accesorio sueltos de la colección (los uploads de Back
 * Cushion / Bolster / Arm Cushion). Aquí el nombre del material SÍ es identidad
 * — pCon reutiliza un id por tipo de parte — que es por lo que estas llevan
 * `matKeys` y sus hermanas de `partFingerprints` deliberadamente no. Cada
 * accesorio carga una vez (el loader cachea por URL); uno roto no aporta nada.
 */
export async function buildAccessoryRefs(accessories) {
  const THREE = await safeDynamicImport(() => import('three'));
  const refs = await Promise.all((accessories || []).map(async (a) => {
    try {
      const { modelFor } = await loadConfiguratorModels({ pieces: [{ mesh: a.mesh }] });
      const acc = modelFor({ mesh: a.mesh });
      if (!acc?.object) return null;
      acc.object.updateMatrixWorld(true);
      const zUp = (a.meshUpAxis || 'y') === 'z';
      const remap = (v) => (zUp ? [v[0], v[2], v[1]] : v);
      const matKeys = [];
      const box = new THREE.Box3().setFromObject(acc.object);
      acc.object.traverse((o) => {
        if (!o.isMesh) return;
        const nm = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
        // Sólo los materiales CON NOMBRE dejan huella — las claves posicionales
        // ("#2") no significan nada entre exports distintos.
        if (nm && String(nm).trim()) matKeys.push(String(nm).trim());
      });
      const rawMin = remap(box.min.toArray()), rawMax = remap(box.max.toArray());
      const rawSize = rawMax.map((v, i) => v - rawMin[i]);
      const unit = autoUnitScale(Math.max(...rawSize));
      return { role: accessoryRoleFor(a.name), matKeys, size: rawSize.map((v) => v * unit) };
    } catch { return null; }
  }));
  return refs.filter((r) => r && r.role);
}
