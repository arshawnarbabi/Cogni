import { createServiceClient } from '@/lib/supabase/server'

export async function requireOwnedCourse(userId: string, courseId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('courses')
    .select('*')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export async function requireOwnedProfessor(userId: string, professorId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('professors')
    .select('*')
    .eq('professor_id', professorId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export async function requireOwnedSession(userId: string, sessionId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('session_log')
    .select('*')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export async function requireOwnedMaterial(userId: string, materialId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('materials')
    .select('*')
    .eq('material_id', materialId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export async function requireOwnedInboxItem(userId: string, itemId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('inbox_items')
    .select('*')
    .eq('inbox_item_id', itemId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export async function requireOwnedCourseFile(userId: string, fileId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('course_files')
    .select('*')
    .eq('file_id', fileId)
    .eq('user_id', userId)
    .single()
  if (error || !data) return null
  return data
}

export function safeStorageFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}
