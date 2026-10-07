import {describe,it,expect} from 'vitest';
import {parseTemplateCommand} from '../../src/worker/template.js';
const version='11111111-1111-4111-8111-111111111111';
describe('bounded template operator command',()=>{
 it('requires an existing user email and explicit test-only publication confirmation',()=>{expect(parseTemplateCommand(['publish','--version',version,'--by','person@example.test','--expected-database','dhumi_test','--evidence','restricted:accepted-proof','--confirm'])).toMatchObject({action:'publish',version,by:'person@example.test',evidence:'restricted:accepted-proof'});});
 it('accepts a private dataset file rather than printing a provider identifier',()=>{expect(parseTemplateCommand(['set-dataset','--version',version,'--by','person@example.test','--expected-database','dhumi_test','--dataset-file','private-binding.txt','--confirm']).datasetFile).toBe('private-binding.txt');});
 it.each([[],['publish'],['publish','--version','invalid'],['publish','--by','anonymous'],['publish','--expected-database','dhumi_dev'],['publish','--confirm','--confirm']].map(args=>({args})))('refuses incomplete, foreign or ambiguous options $args',({args})=>{expect(()=>parseTemplateCommand(args)).toThrow();});
});
