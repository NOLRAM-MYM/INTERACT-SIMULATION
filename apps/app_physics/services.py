"""
apps/app_physics/services.py
=============================
Physics service for computing projectile trajectories with air drag.
"""

import math
import numpy as np

# ---------------------------------------------------------------------------
# DC motor reference point
# ---------------------------------------------------------------------------
# The torque and back-EMF constants a user enters describe a nominal machine.
# The magnet material, pole span and pole count then scale those constants away
# from that nominal point, so the nominal point itself has to be stated
# somewhere. These two names are it.

#: Airgap flux density the entered Kt/Ke are assumed to have been measured at.
B_GAP_REFERENCE_T = 1.0

#: Pole count the entered Kt/Ke are assumed to describe (a 2-pole machine).
POLES_REFERENCE_COUNT = 2


class ProjectileMotionService:
    """
    Computes trajectory of a sphere launched under gravity with quadratic air drag.
    Equations of motion solved numerically:
        m * a = m * g - 0.5 * C_d * rho * A * |v| * v
    """

    def __init__(
        self,
        velocity_m_s: float,
        angle_deg: float,
        mass_kg: float,
        diameter_m: float,
        drag_coefficient: float,
        gravity_m_s2: float = 9.80665,
        air_density_kg_m3: float = 1.225,
    ):
        self.v0 = velocity_m_s
        self.theta_rad = math.radians(angle_deg)
        self.m = mass_kg
        self.d = diameter_m
        self.Cd = drag_coefficient
        self.g = gravity_m_s2
        self.rho = air_density_kg_m3
        self.A = math.pi * (diameter_m / 2.0) ** 2

    def compute(self):
        # 1. Vacuum case (Analytic solution)
        t_flight_vac = (2.0 * self.v0 * math.sin(self.theta_rad)) / self.g
        t_flight_vac = max(t_flight_vac, 0.001)
        h_max_vac = (self.v0 * math.sin(self.theta_rad)) ** 2 / (2.0 * self.g)
        range_vac = self.v0 * math.cos(self.theta_rad) * t_flight_vac

        # Generate vacuum trajectory points
        t_pts_vac = np.linspace(0, t_flight_vac, 100)
        x_vac = self.v0 * math.cos(self.theta_rad) * t_pts_vac
        y_vac = self.v0 * math.sin(self.theta_rad) * t_pts_vac - 0.5 * self.g * t_pts_vac**2
        y_vac = np.clip(y_vac, 0, None)  # Ensure no sub-ground coordinates

        # 2. Drag case (Numerical integration using RK4 method)
        # State vector: [x, y, vx, vy]
        state = np.array([0.0, 0.0, self.v0 * math.cos(self.theta_rad), self.v0 * math.sin(self.theta_rad)])
        
        # RK4 ODE derivative function
        def derivatives(s):
            # s = [x, y, vx, vy]
            vx, vy = s[2], s[3]
            v = math.sqrt(vx**2 + vy**2)
            if v == 0:
                ax = 0.0
                ay = -self.g
            else:
                # Drag force = - 0.5 * Cd * rho * A * v * vec(v)
                drag_force_x = -0.5 * self.Cd * self.rho * self.A * v * vx
                drag_force_y = -0.5 * self.Cd * self.rho * self.A * v * vy
                ax = drag_force_x / self.m
                ay = -self.g + (drag_force_y / self.m)
            return np.array([vx, vy, ax, ay])

        dt = 0.01  # time step in seconds
        trajectory = [state.copy()]
        t = 0.0
        max_steps = 10000
        warnings: list[str] = []

        while state[1] >= 0.0 and len(trajectory) < max_steps:
            # RK4 Integration step
            k1 = derivatives(state)
            k2 = derivatives(state + k1 * (dt / 2.0))
            k3 = derivatives(state + k2 * (dt / 2.0))
            k4 = derivatives(state + k3 * dt)
            
            state += (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (dt / 6.0)
            trajectory.append(state.copy())
            t += dt

            # Safeguard: stop if moving away/underground
            if len(trajectory) > 2 and state[1] < 0.0:
                break

        traj_arr = np.array(trajectory)

        # The loop above also exits on max_steps, which at dt = 0.01 s caps the
        # flight at 100 s. A fast, low-drag launch (the serializer allows up to
        # 1000 m/s and a drag coefficient of 0) is still climbing or falling
        # when that hits, and every KPI below then describes a projectile that
        # never landed. Say so rather than reporting a landing that didn't
        # happen.
        if len(trajectory) >= max_steps and traj_arr[-1, 1] > 0.0:
            warnings.append(
                f"Integration stopped at the {max_steps}-step limit "
                f"({max_steps * dt:.0f} s) with the projectile still "
                f"{traj_arr[-1, 1]:.1f} m above the ground. Range and flight "
                f"time are lower bounds, not the true impact values."
            )

        # Interpolate final hit point for precision
        if len(traj_arr) > 1 and traj_arr[-1, 1] < 0.0:
            last = traj_arr[-2]
            current = traj_arr[-1]
            # fraction of step to hit ground y = 0
            fraction = -last[1] / (current[1] - last[1]) if current[1] != last[1] else 0.0
            hit_state = last + fraction * (current - last)
            traj_arr[-1] = hit_state
            t = t - dt + fraction * dt

        x_drag = traj_arr[:, 0]
        y_drag = traj_arr[:, 1]
        
        # Cap arrays at ~100 elements for client rendering efficiency
        step_sz = max(1, len(x_drag) // 100)
        x_drag_resampled = x_drag[::step_sz].tolist()
        y_drag_resampled = y_drag[::step_sz].tolist()

        # Ensure the exact impact point is the last sample. The slice above only
        # lands on it when len-1 is a multiple of step_sz; appending
        # unconditionally duplicated it in exactly those cases, which draws a
        # zero-length final segment and repeats a row in the exported data.
        if len(x_drag) > 0 and (len(x_drag) - 1) % step_sz != 0:
            x_drag_resampled.append(float(x_drag[-1]))
            y_drag_resampled.append(float(y_drag[-1]))

        # KPIs for drag case
        range_drag = float(x_drag[-1])
        h_max_drag = float(np.max(y_drag))
        t_flight_drag = float(t)
        v_final_drag = float(math.sqrt(traj_arr[-1, 2]**2 + traj_arr[-1, 3]**2))

        return {
            "x_vacuum": x_vac.tolist(),
            "y_vacuum": y_vac.tolist(),
            "x_drag": x_drag_resampled,
            "y_drag": y_drag_resampled,
            "warnings": warnings,
            "stats": {
                "range_vacuum_m": float(range_vac),
                "height_vacuum_m": float(h_max_vac),
                "time_vacuum_s": float(t_flight_vac),
                "range_drag_m": range_drag,
                "height_drag_m": h_max_drag,
                "time_drag_s": t_flight_drag,
                "final_velocity_drag_m_s": v_final_drag,
                "truncated": bool(warnings),
            }
        }


class MagnetismService:
    """
    Computes physical interactions for magnetism and motors:
    1. Charged particle in uniform magnetic field (Lorentz trajectory).
    2. Force between two magnetic poles.
    3. Transient response of a Permanent Magnet DC Motor (PMDC).
    """

    @staticmethod
    def compute_lorentz(q_uc: float, m_mg: float, v0: list, B: list, t_max: float = 2.0, dt: float = 0.005):
        # q_uc in micro-Coulombs, m_mg in milligrams
        # Scaling factor: q/m in C/kg is exactly q_uc/m_mg.
        # q = q_uc * 1e-6 C, m = m_mg * 1e-6 kg, so q/m = q_uc / m_mg
        q_over_m = q_uc / m_mg if m_mg != 0 else 0.0

        # State: [x, y, z, vx, vy, vz]
        state = np.array([0.0, 0.0, 0.0, float(v0[0]), float(v0[1]), float(v0[2])])
        Bx, By, Bz = float(B[0]), float(B[1]), float(B[2])
        B_mag = math.sqrt(Bx**2 + By**2 + Bz**2)

        def derivatives(s):
            vx, vy, vz = s[3], s[4], s[5]
            # acceleration = q/m * (v x B)
            # v x B = [vy*Bz - vz*By, vz*Bx - vx*Bz, vx*By - vy*Bx]
            ax = q_over_m * (vy * Bz - vz * By)
            ay = q_over_m * (vz * Bx - vx * Bz)
            az = q_over_m * (vx * By - vy * Bx)
            return np.array([vx, vy, vz, ax, ay, az])

        trajectory = [state.copy()]
        t = 0.0
        steps = int(t_max / dt)

        for _ in range(steps):
            k1 = derivatives(state)
            k2 = derivatives(state + k1 * (dt / 2.0))
            k3 = derivatives(state + k2 * (dt / 2.0))
            k4 = derivatives(state + k3 * dt)

            state += (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (dt / 6.0)
            trajectory.append(state.copy())
            t += dt

        traj_arr = np.array(trajectory)

        # Downsample for frontend
        step_sz = max(1, len(traj_arr) // 100)
        resampled = traj_arr[::step_sz]

        x = resampled[:, 0].tolist()
        y = resampled[:, 1].tolist()
        z = resampled[:, 2].tolist()
        vx = resampled[:, 3].tolist()
        vy = resampled[:, 4].tolist()
        vz = resampled[:, 5].tolist()

        # Calculate force at each step: F = q * (v x B)
        q_c = q_uc * 1e-6
        Fx = [q_c * (vy_i * Bz - vz_i * By) for vy_i, vz_i in zip(vy, vz)]
        Fy = [q_c * (vz_i * Bx - vx_i * Bz) for vx_i, vz_i in zip(vx, vz)]
        Fz = [q_c * (vx_i * By - vy_i * Bx) for vx_i, vy_i in zip(vx, vy)]

        # Larmor radius: R = m * v_perp / (|q| * B)
        # v_perp = |v x B| / |B|
        # cyclotron frequency: f = |q| * B / (2 * pi * m)
        v_mag = math.sqrt(v0[0]**2 + v0[1]**2 + v0[2]**2)
        if B_mag > 0:
            # Cross product v x B
            cross_x = v0[1]*Bz - v0[2]*By
            cross_y = v0[2]*Bx - v0[0]*Bz
            cross_z = v0[0]*By - v0[1]*Bx
            cross_mag = math.sqrt(cross_x**2 + cross_y**2 + cross_z**2)
            v_perp = cross_mag / B_mag

            if q_uc != 0:
                larmor_r = (m_mg * v_perp) / (abs(q_uc) * B_mag)
                cyclotron_f = (abs(q_uc) * B_mag) / (2.0 * math.pi * m_mg)
            else:
                larmor_r = float('inf')
                cyclotron_f = 0.0
        else:
            v_perp = 0.0
            larmor_r = float('inf')
            cyclotron_f = 0.0

        return {
            "x": x, "y": y, "z": z,
            "vx": vx, "vy": vy, "vz": vz,
            "Fx": Fx, "Fy": Fy, "Fz": Fz,
            "stats": {
                "larmor_radius_m": None if larmor_r == float('inf') else larmor_r,
                "cyclotron_frequency_hz": cyclotron_f,
                "velocity_perp_m_s": v_perp,
                "velocity_total_m_s": v_mag,
                "magnetic_field_mag_t": B_mag,
            }
        }

    @staticmethod
    def compute_poles(qm1: float, qm2: float, r: float):
        # Coulomb's law for magnetism: F = mu_0 * qm1 * qm2 / (4 * pi * r^2)
        # F = 1e-7 * qm1 * qm2 / r^2
        # Sweep a window centred on the operating separation instead of a fixed
        # 0.05-2 m span. `r` has no upper bound and only a cross-field check for
        # positivity, so outside that span the operating-point marker the chart
        # draws fell off the plotted curve entirely.
        r_lo = max(r * 0.2, 1e-4)
        r_hi = max(r * 2.0, r_lo * 1.01)
        r_profile = np.linspace(r_lo, r_hi, 100)
        f_profile = (1e-7 * qm1 * qm2) / (r_profile ** 2)

        force_val = (1e-7 * qm1 * qm2) / (r ** 2) if r > 0 else 0.0

        # Sign convention: like poles give a positive (repulsive) product,
        # opposite poles a negative (attractive) one. Zero is neither — it used
        # to fall through to "Repulsion".
        if force_val > 0:
            interaction = "Repulsion"
        elif force_val < 0:
            interaction = "Attraction"
        else:
            interaction = "None"

        return {
            "r_profile": r_profile.tolist(),
            "f_profile": f_profile.tolist(),
            "stats": {
                "distance_m": r,
                "force_n": force_val,
                "type": interaction,
            }
        }

    @staticmethod
    def compute_motor(
        V: float, R: float, L: float, J: float, b: float, Kt: float, Ke: float, tl: float,
        poles_count: int = 2, magnet_material: str = "ndfeb_n52", pole_span_deg: float = 120.0,
        t_max: float = 1.5
    ):
        MATERIALS = {
            "ndfeb_n52": {"name": "Neodímio N52 (NdFeB)", "br": 1.45, "temp_max": "80°C"},
            "ndfeb_n42": {"name": "Neodímio N42 (NdFeB)", "br": 1.30, "temp_max": "80°C"},
            "smco": {"name": "Samário-Cobalto (Sm2Co17)", "br": 1.10, "temp_max": "300°C"},
            "alnico5": {"name": "AlNiCo 5", "br": 1.25, "temp_max": "525°C"},
            "ferrite": {"name": "Ferrite Bário (Y30)", "br": 0.40, "temp_max": "250°C"},
        }
        mat_info = MATERIALS.get(magnet_material, MATERIALS["ndfeb_n52"])
        br = mat_info["br"]

        # Calculated Airgap Flux Density: B_gap = B_r * (span_deg / 180.0) * leakage_factor (0.85)
        span_clamped = max(30.0, min(170.0, float(pole_span_deg)))
        b_gap = br * (span_clamped / 180.0) * 0.85

        # Effective torque & back-EMF constants.
        #
        # Kt and Ke are entered for a nominal machine; the magnet choice, pole
        # span and pole count scale them away from that nominal point. Both
        # reference values are named rather than left as bare literals — the
        # airgap ratio used to be written `b_gap / 1.0`, which read as a no-op
        # and hid the fact that 1 T is the assumed design point.
        #
        # Torque per amp is proportional to the number of active pole pairs, so
        # `poles_count` scales the constants relative to the 2-pole reference.
        # It used to be validated, threaded all the way down here, and then only
        # echoed back in the response — changing "Pole Count" in the UI moved no
        # number at all.
        pole_pairs = max(1, int(poles_count) // 2)
        pole_factor = pole_pairs / (POLES_REFERENCE_COUNT // 2)

        flux_factor = (b_gap / B_GAP_REFERENCE_T) * pole_factor
        Kt_eff = Kt * flux_factor
        Ke_eff = Ke * flux_factor

        dt = 0.001
        # State: [I, omega]
        state = np.array([0.0, 0.0])

        def derivatives(s):
            I, omega = s[0], s[1]
            dI = (V - R * I - Ke_eff * omega) / L
            domega = (Kt_eff * I - b * omega - tl) / J
            return np.array([dI, domega])

        t_pts = np.arange(0, t_max + dt, dt)
        trajectory = []

        for t in t_pts:
            trajectory.append(state.copy())
            k1 = derivatives(state)
            k2 = derivatives(state + k1 * (dt / 2.0))
            k3 = derivatives(state + k2 * (dt / 2.0))
            k4 = derivatives(state + k3 * dt)
            state += (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (dt / 6.0)

        traj_arr = np.array(trajectory)
        I = traj_arr[:, 0]
        omega = traj_arr[:, 1]

        # Calculate torque: tau = Kt_eff * I
        torque = Kt_eff * I

        # Calculate efficiency: eta = (tau * omega) / (V * I) * 100
        efficiency = []
        for t_val, i_val, o_val in zip(torque, I, omega):
            p_in = V * i_val
            p_out = t_val * o_val
            if p_in > 1e-5 and p_out > 0:
                eff = (p_out / p_in) * 100.0
                efficiency.append(min(99.5, eff))
            else:
                efficiency.append(0.0)

        # Steady state values: last 50 points average
        steady_speed = float(np.mean(omega[-50:]))
        steady_speed_rpm = steady_speed * (30.0 / math.pi)
        steady_current = float(np.mean(I[-50:]))
        steady_torque = float(np.mean(torque[-50:]))

        # Power calculations at steady state
        p_elec = V * steady_current
        p_mech = steady_torque * steady_speed
        p_cu = (steady_current ** 2) * R
        efficiency_steady = (p_mech / p_elec * 100.0) if p_elec > 1e-3 and p_mech > 0 else 0.0
        efficiency_steady = min(99.5, max(0.0, efficiency_steady))

        starting_current = float(np.max(I))
        max_torque = float(np.max(torque))
        max_eff = float(np.max(efficiency))

        # Settling time: time to reach within 5% of final steady state speed
        settling_time = t_max
        for idx, o_val in enumerate(omega):
            err = abs(o_val - steady_speed)
            limit = 0.05 * abs(steady_speed) if abs(steady_speed) > 1.0 else 0.05
            if err <= limit:
                remaining = omega[idx:]
                if np.all(np.abs(remaining - steady_speed) <= limit):
                    settling_time = float(t_pts[idx])
                    break

        # Downsample arrays for plotting
        step_sz = max(1, len(t_pts) // 150)
        t_res = t_pts[::step_sz].tolist()
        I_res = I[::step_sz].tolist()
        omega_res = omega[::step_sz].tolist()
        omega_rpm_res = [w * (30.0 / math.pi) for w in omega_res]
        torque_res = torque[::step_sz].tolist()
        eff_res = efficiency[::step_sz]
        if isinstance(eff_res, np.ndarray):
            eff_res = eff_res.tolist()
        else:
            eff_res = list(eff_res)

        return {
            "t": t_res,
            "I": I_res,
            "speed_rad_s": omega_res,
            "speed_rpm": omega_rpm_res,
            "torque_nm": torque_res,
            "efficiency_pct": eff_res,
            "stats": {
                "steady_state_speed_rpm": steady_speed_rpm,
                "steady_state_speed_rad_s": steady_speed,
                "starting_current_a": starting_current,
                "settling_time_s": settling_time,
                "max_torque_nm": max_torque,
                "max_efficiency_pct": max_eff,
                "poles_count": poles_count,
                "magnet_material": magnet_material,
                "magnet_material_name": mat_info["name"],
                "remanence_br_t": br,
                "b_gap_t": round(b_gap, 3),
                "pole_span_deg": round(span_clamped, 1),
                "p_elec_w": round(p_elec, 2),
                "p_mech_w": round(p_mech, 2),
                "p_cu_w": round(p_cu, 2),
                "efficiency_steady_pct": round(efficiency_steady, 1),
            }
        }

