//! Named layout templates (agent C). Saving is always an explicit user action; restoring is done
//! by the renderer from the listed template and connects nothing until the user asks.

use tauri::State;
use tyrminal_core::contracts::{IpcError, LayoutTemplateInput, LayoutTemplateSummary};

use crate::state::AppState;

#[tauri::command]
pub async fn layout_list(state: State<'_, AppState>) -> Result<Vec<LayoutTemplateSummary>, IpcError> {
    state.core()?.vault.list_layouts().await
}

#[tauri::command]
pub async fn layout_save(
    state: State<'_, AppState>,
    layout: LayoutTemplateInput,
) -> Result<LayoutTemplateSummary, IpcError> {
    state.core()?.vault.save_layout(layout).await
}

#[tauri::command]
pub async fn layout_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core()?.vault.delete_layout(&id).await
}
