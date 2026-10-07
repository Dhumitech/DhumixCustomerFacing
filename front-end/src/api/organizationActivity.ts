import { getActivity,type GetActivityData } from './generated';
import { dhumiClient } from './client';
import { organizationHeaders } from './organizationScope';
import { asDhumiRequest } from './errors';
export async function organizationActivity(query:GetActivityData['query']) {
  return (await asDhumiRequest(getActivity({client:dhumiClient,headers:organizationHeaders(),query,throwOnError:true}))).data;
}
