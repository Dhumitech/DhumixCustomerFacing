import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const launcher=fileURLToPath(new URL("../../scripts/refactor-review/Review-0071.ps1",import.meta.url));
const runner=fileURLToPath(new URL("../../scripts/migrate.ps1",import.meta.url));
const targets=["postgresql://postgres@localhost:5432/dhumi_dev","postgresql://postgres@localhost:65471/dhumi_test","postgresql://dhumi_test_identity_login@localhost:5432/dhumi_test"];
const cases=[{file:launcher,args:[]},{file:launcher,args:["-Apply","-ReviewedSqlSha256","00".repeat(32)]},
  {file:runner,args:["-DatabaseUrl","postgresql://postgres@localhost:5432/dhumi_test"]},
  ...targets.map(target=>({file:runner,args:["-DatabaseUrl",target,"-Reviewed0071Sha256","00".repeat(32)]}))];
let results:{status:number;stdout:string;stderr:string}[]=[];
beforeAll(()=> {
  if(process.platform!=="win32") return;
  const encoded=Buffer.from(JSON.stringify(cases)).toString("base64");
  // One shell start for all local refusal checks. No fake psql, connection,
  // credential loader or timing-sensitive seven-process startup sequence.
  const code=`$ErrorActionPreference='Stop'; $items=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json); $results=@(foreach($item in $items){try{$arguments=@{};for($i=0;$i -lt $item.args.Count;$i++){ $name=$item.args[$i].Substring(1);if($name -eq 'Apply'){$arguments[$name]=$true}else{$i++;$arguments[$name]=$item.args[$i]}}; $output=(& $item.file @arguments 6>&1|Out-String);[pscustomobject]@{status=0;stdout=$output;stderr=''}}catch{[pscustomobject]@{status=1;stdout='';stderr=$_.Exception.Message}}});ConvertTo-Json -InputObject $results -Compress -Depth 5`;
  const result=spawnSync("pwsh.exe",["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{encoding:"utf8",windowsHide:true,timeout:15000});
  if(result.error) throw result.error;
  expect(result.status).toBe(0);results=JSON.parse(result.stdout);
},20000);
function command(file:string,args:string[]) {
  const index=cases.findIndex(item=>item.file===file&&JSON.stringify(item.args)===JSON.stringify(args));
  if(index<0||!results[index]) throw Error("Missing local refusal result");return results[index]!;
}
describe.skipIf(process.platform!=="win32")("0071 bounded migration review launcher",()=> {
  it("defaults to local review without connecting or reading a credential",()=> {
    const result=command(launcher,[]);expect(result.status).toBe(0);
    expect(result.stdout).toContain("REVIEW ONLY: no database connection, credential read, SQL execution or ledger write");
  });
  it("rejects an unreviewed SQL hash before a prompt or connection",()=> {
    const result=command(launcher,["-Apply","-ReviewedSqlSha256","00".repeat(32)]);
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("ReviewedSqlSha256 must match");
    expect(result.stdout).not.toContain("password (held only");
  });
  it("generic migration application refuses the refactor chain",()=> {
    const result=command(runner,["-DatabaseUrl","postgresql://postgres@localhost:5432/dhumi_test"]);
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("phase-specific review launcher");
  });
  it.each(targets)("rejects out-of-scope endpoint/runtime identity %s before connecting",target=> {
    const result=command(runner,["-DatabaseUrl",target,"-Reviewed0071Sha256","00".repeat(32)]);
    expect(result.status).not.toBe(0);expect(result.stderr).toMatch(/restricted to|not a runtime identity/);
  });
  it("keeps atomic SQL/ledger insertion and pin/cutover gates in the existing runner",()=> {
    const code=readFileSync(runner,"utf8"), review=readFileSync(launcher,"utf8");
    expect(code).toContain("--single-transaction");expect(code).toContain("--command $ledgerInsertSql");
    expect(code).toContain("Select exactly one reviewed refactor migration");
    expect(review).toContain("pendingBeforeApplication");expect(review).toContain("$receipt.sourcePins");
    expect(review).toContain("$receipt.evidencePins");expect(review).toContain("$receipt.backup.dump");
    expect(review.indexOf("pendingBeforeApplication")).toBeLessThan(review.indexOf("-PromptForPassword"));
  });
});
