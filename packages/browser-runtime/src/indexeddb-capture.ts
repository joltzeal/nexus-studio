import type { Page } from 'playwright-core'

export async function captureIndexedDB(page: Page): Promise<unknown[]> {
  // The pinned Playwright collector drops falsy values and JSON cannot carry
  // non-finite numbers. Emit its supported encoded-value format for every record.
  // Keep this browser-side script independent of Node globals and TypeScript helpers.
  const result: unknown = await page.evaluate(`(async () => {
    const unsupported = () => { throw new Error('PORTABLE_STATE_INDEXED_DB_UNSUPPORTED'); };
    const request = req => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('PORTABLE_STATE_INDEXED_DB_READ_FAILED'));
    });
    const base64 = bytes => {
      let binary = '';
      for (let offset=0; offset<bytes.length; offset+=8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset+8192));
      return btoa(binary);
    };
    const typedArrays = new Map([
      [Int8Array,'i8'], [Uint8Array,'ui8'], [Uint8ClampedArray,'ui8c'],
      [Int16Array,'i16'], [Uint16Array,'ui16'], [Int32Array,'i32'],
      [Uint32Array,'ui32'], [Float32Array,'f32'], [Float64Array,'f64'],
      [BigInt64Array,'bi64'], [BigUint64Array,'bui64']
    ]);
    const encode = (value, refs=new Map()) => {
      if (value === undefined) return {v:'undefined'};
      if (value === null) return {v:'null'};
      if (typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return {v:'NaN'};
        if (value === Infinity) return {v:'Infinity'};
        if (value === -Infinity) return {v:'-Infinity'};
        if (Object.is(value,-0)) return {v:'-0'};
        return value;
      }
      if (typeof value === 'bigint') return {bi:value.toString()};
      if (typeof value !== 'object') unsupported();
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) unsupported();
        return {d:value.toISOString()};
      }
      if (value instanceof RegExp) return {r:{p:value.source,f:value.flags}};
      if (value instanceof URL) return {u:value.href};
      if (value instanceof Error) {
        if ('cause' in value || Object.keys(value).length) unsupported();
        return {e:{n:value.name,m:value.message,s:value.stack}};
      }
      if (value instanceof ArrayBuffer)
        return {ab:{b:base64(new Uint8Array(value))}};
      for (const [Constructor, kind] of typedArrays) {
        if (value instanceof Constructor)
          return {ta:{k:kind,b:base64(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))}};
      }
      if (refs.has(value)) return {ref:refs.get(value)};
      const id=refs.size+1;
      refs.set(value,id);
      if (Array.isArray(value)) {
        for (let i=0;i<value.length;i++) if (!(i in value)) unsupported();
        if (Object.keys(value).some(key=>! /^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=value.length))
          unsupported();
        return {id,a:value.map(entry=>encode(entry,refs))};
      }
      if (value instanceof Map)
        return {id,m:[...value].map(([k,v])=>({k:encode(k,refs),v:encode(v,refs)}))};
      if (value instanceof Set)
        return {id,s:[...value].map(entry=>encode(entry,refs))};
      const prototype=Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) unsupported();
      if (Object.hasOwn(value,'__proto__')) unsupported();
      return {id,o:Object.keys(value).map(k=>({k,v:encode(value[k],refs)}))};
    };
    const keyPath = path => typeof path === 'string'
      ? {keyPath:path} : Array.isArray(path) ? {keyPathArray:path} : {};
    const databases = await indexedDB.databases();
    const result=[];
    for (const info of databases) {
      if (typeof info.name !== 'string' || !Number.isSafeInteger(info.version))
        unsupported();
      const db=await request(indexedDB.open(info.name));
      try {
        const names=[...db.objectStoreNames];
        let stores=[];
        if (names.length) {
          const transaction=db.transaction(names,'readonly');
          stores=await Promise.all(names.map(async name => {
            const store=transaction.objectStore(name);
            const indexes=[...store.indexNames].map(name => {
              const index=store.index(name);
              return {
                name:index.name,...keyPath(index.keyPath),
                unique:index.unique,multiEntry:index.multiEntry
              };
            });
            const [keys,values]=await Promise.all([
              request(store.getAllKeys()),request(store.getAll())
            ]);
            if (keys.length !== values.length) unsupported();
            return {
              name:store.name,autoIncrement:store.autoIncrement,...keyPath(store.keyPath),
              indexes,records:values.map((value,index)=>({
                ...(store.keyPath === null ? {keyEncoded:encode(keys[index])} : {}),
                valueEncoded:encode(value)
              }))
            };
          }));
        }
        result.push({name:db.name,version:db.version,stores});
      } finally {
        db.close();
      }
    }
    return result;
  })()`)
  if (!Array.isArray(result)) throw new Error('PORTABLE_STATE_INDEXED_DB_READ_FAILED')
  return result
}
