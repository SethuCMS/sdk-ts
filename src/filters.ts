/**
 * Building filters. Each helper returns plain data that the API understands,
 * so filters can also be stored or sent as JSON.
 */
export type Operator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'nin' | 'contains' | 'startsWith' | 'exists';

export type Scalar = string | number | boolean | null;

export interface Comparison {
  field: string;
  op: Operator;
  value?: Scalar | Scalar[];
}
export type Filter = Comparison | { and: Filter[] } | { or: Filter[] } | { not: Filter };

export const eq = (field: string, value: Scalar): Filter => ({ field, op: 'eq', value });
export const ne = (field: string, value: Scalar): Filter => ({ field, op: 'ne', value });
export const lt = (field: string, value: Scalar): Filter => ({ field, op: 'lt', value });
export const lte = (field: string, value: Scalar): Filter => ({ field, op: 'lte', value });
export const gt = (field: string, value: Scalar): Filter => ({ field, op: 'gt', value });
export const gte = (field: string, value: Scalar): Filter => ({ field, op: 'gte', value });
export const isIn = (field: string, values: Scalar[]): Filter => ({ field, op: 'in', value: values });
export const notIn = (field: string, values: Scalar[]): Filter => ({ field, op: 'nin', value: values });
export const contains = (field: string, value: string | number | boolean): Filter => ({ field, op: 'contains', value });
export const startsWith = (field: string, value: string): Filter => ({ field, op: 'startsWith', value });
export const exists = (field: string, present = true): Filter => ({ field, op: 'exists', value: present });

export const and = (...filters: Filter[]): Filter => ({ and: filters });
export const or = (...filters: Filter[]): Filter => ({ or: filters });
export const not = (filter: Filter): Filter => ({ not: filter });
