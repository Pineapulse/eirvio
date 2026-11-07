import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Logger} from '@babylonjs/core/Misc/logger.js';
import {installWeb} from '../packages/sdk/src/web.mjs';
import {installBabylon} from '../packages/sdk/src/babylon.mjs';
import {createSurfaceAdapter} from '../packages/sdk/src/surface.mjs';
import {webScenarios} from './scenarios/web.mjs';
import {babylonScenarios} from './scenarios/babylon.mjs';
import {kernelScenarios} from './scenarios/kernel.mjs';
import {LAB_SCHEMA_VERSION,validateConfig,evaluateScenarios,compareResults} from './evaluate.mjs';
import {loadBaseline,candidateSource,saveReport} from './baseline.mjs';
Logger.LogLevels=Logger.NoneLogLevel;
export const scenarios=[...webScenarios,...babylonScenarios,...kernelScenarios];
export async function runLab(options={}) {
  const config=validateConfig(options),startedAt=new Date().toISOString(),source=candidateSource();
  let baseline,baselineRun;
  try {
    if(config.mode==='learning') {
      baseline=await loadBaseline();
      baselineRun=await evaluateScenarios(scenarios,baseline.adapters,config);
    }
    const candidate=await evaluateScenarios(scenarios,{installWeb,installBabylon,createSurfaceAdapter},config);
    const report={schemaVersion:LAB_SCHEMA_VERSION,runId:randomUUID(),startedAt,completedAt:new Date().toISOString(),config,
      candidate:{source,...candidate},...(baseline?{baseline:{source:baseline.source,...baselineRun},comparison:compareResults(baselineRun,candidate)}:{}),
      purpose:'Synthetic, reproducible engine evaluation. No model training, live user data or external analytics.'};
    const path=await saveReport(report);
    return {report,path};
  } finally {await baseline?.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),mode=args.shift()??'testing';
    if(args.length>1)throw new Error('Usage: node lab/run.mjs testing|learning [seed]');
    const {report,path}=await runLab({mode,seed:args.length?Number(args[0]):42});
    const summary=report.candidate.summary;
    console.log(`${mode}: ${summary.passed}/${summary.attempts} candidate attempts passed (${summary.scenarios} scenarios).`);
    if(report.baseline)console.log(`Baseline: ${report.baseline.summary.passed}/${report.baseline.summary.attempts} passed. Improvements: ${report.comparison.improvements.length}; regressions: ${report.comparison.regressions.length}.`);
    console.log(`Report: ${path}`);
    process.send?.({type:'complete',path,report});
    if(summary.failed)process.exitCode=1;
  } catch(error) {
    console.error(error.message);process.send?.({type:'failed',message:String(error.message).slice(0,800)});process.exitCode=1;
  } finally {process.disconnect?.();}
}
