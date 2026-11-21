import { useEffect } from "react";
import { SelectField } from "../shared/ui/SelectField";
import { useNativeForm, nativeFormProblem } from "./profile-form-adapter";
import { useWorkspace } from "./store";

export function NativeKernelField() {
  const state = useWorkspace();
  const context = useNativeForm();
  useEffect(() => {
    if (!context.kernelVersion && state.kernels?.installed[0]) useNativeForm.setState({ kernelVersion: state.kernels.installed[0].version });
  }, [context.kernelVersion, state.kernels]);
  return <SelectField label="ShardBrowser 内核" value={context.kernelVersion}
    onChange={(kernelVersion) => useNativeForm.setState({ kernelVersion })}
    options={(state.kernels?.installed ?? []).map((kernel) => ({ value: kernel.version, label: kernel.version }))} />;
}

export function NativeFormStatus() {
  useWorkspace();
  useNativeForm();
  const problem = nativeFormProblem();
  return problem ? <span role="status">{problem}</span> : null;
}
