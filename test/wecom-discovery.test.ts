import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWecomConfigPaths, registerWecomConfig } from '../src/im/wecom/config/discovery.js';
const roots:string[]=[]; afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
it('默认路径不依赖索引，损坏索引不隐藏默认配置，也不被注册静默覆盖',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wecom-discovery-'));roots.push(root);const index=join(root,'config-registry.json');writeFileSync(index,'broken');
 expect(readWecomConfigPaths(root)).toEqual([join(root,'config.json')]);await expect(registerWecomConfig(join(root,'custom.json'),root)).rejects.toThrow('wecom_registry_invalid');expect(readFileSync(index,'utf8')).toBe('broken');
});
it('只发现明确注册的自定义路径，真实并发锁合并而非相互丢失',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wecom-discovery-'));roots.push(root);const secretDirectory=join(root,'unscanned');mkdirSync(secretDirectory);writeFileSync(join(secretDirectory,'hidden.json'),'{}');
 await Promise.all([registerWecomConfig(join(root,'one.json'),root),registerWecomConfig(join(root,'two.json'),root)]);
 expect(readWecomConfigPaths(root)).toEqual(expect.arrayContaining([join(root,'config.json'),join(root,'one.json'),join(root,'two.json')]));expect(readWecomConfigPaths(root)).toHaveLength(3);
});
// Mutation: dropping the logged set (log on every lenient read), or never clearing it after a clean read, turns this red.
it('reports a damaged registry once per run of damage, however often it is read, and again after a clean read',()=>{
 const root=mkdtempSync(join(tmpdir(),'wecom-discovery-'));roots.push(root);const index=join(root,'config-registry.json');
 const error=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  writeFileSync(index,'broken');
  for(let i=0;i<5;i++)expect(readWecomConfigPaths(root)).toEqual([join(root,'config.json')]);
  expect(error).toHaveBeenCalledTimes(1);
  writeFileSync(index,JSON.stringify({version:1,paths:[]}));readWecomConfigPaths(root);expect(error).toHaveBeenCalledTimes(1);
  writeFileSync(index,'broken again');readWecomConfigPaths(root);readWecomConfigPaths(root);expect(error).toHaveBeenCalledTimes(2);
 }finally{error.mockRestore();}
});
