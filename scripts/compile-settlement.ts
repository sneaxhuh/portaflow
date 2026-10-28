import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak256 } from 'viem';
const solc = createRequire(import.meta.url)('solc');
const source = readFileSync('contracts/InvoiceSettlement.sol', 'utf8');
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'InvoiceSettlement.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', metadata: { bytecodeHash: 'none', appendCBOR: false },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
for (const error of output.errors || []) if (error.severity === 'error') throw new Error(error.formattedMessage);
const compiled = output.contracts['InvoiceSettlement.sol'].InvoiceSettlement;
const bytecode = ('0x' + compiled.evm.bytecode.object) as `0x${string}`;
const deployedBytecode = ('0x' + compiled.evm.deployedBytecode.object) as `0x${string}`;
const runtimeCodeHash = keccak256(deployedBytecode);
mkdirSync('contracts/artifacts', { recursive: true });
const files = {
  'contracts/artifacts/InvoiceSettlement.json': JSON.stringify({ compiler: solc.version(), abi: compiled.abi, bytecode, deployedBytecode, runtimeCodeHash }, null, 2) + '\n',
  'shared/settlement-code.json': JSON.stringify({ runtimeCodeHash, creationCodeHash: keccak256(bytecode) }, null, 2) + '\n',
};
for(const [path,contents] of Object.entries(files)) {
  if(process.argv.includes('--check')) { if(readFileSync(path,'utf8')!==contents) throw new Error('Settlement artifact is stale. Run npm run build:contracts.'); }
  else writeFileSync(path,contents);
}
console.log(JSON.stringify({ compiler: solc.version(), runtimeBytes: (deployedBytecode.length - 2) / 2, runtimeCodeHash, deployed: false }));
