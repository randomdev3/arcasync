<script lang="ts">
import { FOLDER_STATE_LABEL, type FolderState } from "../settings/model";

const { state }: { state: FolderState } = $props();
</script>

<span class="arcasync-pill" data-state={state}>{FOLDER_STATE_LABEL[state]}</span>
