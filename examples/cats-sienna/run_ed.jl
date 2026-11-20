# Run a one-week PowerSimulations economic dispatch on the CATS system that
# build_system.jl wrote, and copy the results store to OUTPUT_DIR.
#
#   OUTPUT_DIR   folder with system.json; gets simulation_store.h5
#   STEPS        number of 24-hour decision steps (default: all windows)
#   HIGHS_SOLVER ipm (default) or simplex; HIGHS_CROSSOVER on (default) or off
#
# Model: DC power flow with angles (DCPPowerModel) and network slacks, so a
# congested hour shows up as slack instead of an infeasible step. Thermal
# units use ThermalBasicDispatch (no unit commitment), solar and wind can be
# curtailed (RenewableFullDispatch), loads are fixed (StaticPowerLoad).

using PowerSystems
using PowerSimulations
using HiGHS
using Dates
using Logging
const PSY = PowerSystems
const PSI = PowerSimulations

const OUTPUT_DIR = get(ENV, "OUTPUT_DIR", "/output")
const SIM_NAME = "cats_ed"

sys = System(joinpath(OUTPUT_DIR, "system.json"))
windows = PSY.get_forecast_window_count(sys)
steps = parse(Int, get(ENV, "STEPS", string(windows)))
@info "Loaded system" windows steps

template = ProblemTemplate(NetworkModel(DCPPowerModel; use_slacks = true))
set_device_model!(template, ThermalStandard, ThermalBasicDispatch)
set_device_model!(template, RenewableDispatch, RenewableFullDispatch)
set_device_model!(template, PowerLoad, StaticPowerLoad)
set_device_model!(template, Line, StaticBranch)
set_device_model!(template, Transformer2W, StaticBranch)

# Interior point (with crossover, so PowerSimulations gets an optimal vertex
# solution) is much faster than dual simplex on this LP: about 0.5 M
# variables per daily step. Set HIGHS_SOLVER=simplex to compare.
solver = optimizer_with_attributes(HiGHS.Optimizer,
    "solver" => get(ENV, "HIGHS_SOLVER", "ipm"),
    "run_crossover" => get(ENV, "HIGHS_CROSSOVER", "on"),
    "log_to_console" => get(ENV, "HIGHS_LOG", "false") == "true",
)

models = SimulationModels(
    decision_models = [DecisionModel(template, sys; name = "ED", optimizer = solver,
        optimizer_solve_log_print = false, calculate_conflict = false)],
)
sequence = SimulationSequence(models = models, ini_cond_chronology = InterProblemChronology())

sim = Simulation(
    name = SIM_NAME,
    steps = steps,
    models = models,
    sequence = sequence,
    simulation_folder = OUTPUT_DIR,
)
t0 = time()
build!(sim; console_level = Logging.Info, file_level = Logging.Info)
@info "Built simulation" seconds = round(time() - t0; digits = 1)
t1 = time()
status = execute!(sim; enable_progress_bar = false)
status == PSI.RunStatus.SUCCESSFULLY_FINALIZED || error("simulation did not finish: $status")
@info "Executed simulation" seconds = round(time() - t1; digits = 1)

src = joinpath(OUTPUT_DIR, SIM_NAME, "data_store", "simulation_store.h5")
isfile(src) || error("simulation_store.h5 not found at $src")
cp(src, joinpath(OUTPUT_DIR, "simulation_store.h5"); force = true)
rm(joinpath(OUTPUT_DIR, SIM_NAME); recursive = true)
@info "Wrote results" path = joinpath(OUTPUT_DIR, "simulation_store.h5")
